import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { UniBudgetStack } from '../lib/cdk-stack';

function createTemplate(props: ConstructorParameters<typeof UniBudgetStack>[2] = {}) {
  const app = new cdk.App();
  const stack = new UniBudgetStack(app, 'TestUniBudgetStack', props);
  return Template.fromStack(stack);
}

describe('UniBudget infrastructure', () => {
  test('creates a protected, encrypted PostgreSQL instance in a private subnet', () => {
    const template = createTemplate();

    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      DBInstanceClass: 'db.t4g.micro',
      AllocatedStorage: '20',
      StorageEncrypted: true,
      PubliclyAccessible: false,
      MultiAZ: false,
      DeletionProtection: true,
      BackupRetentionPeriod: 7,
      VPCSecurityGroups: Match.anyValue(),
      DBSubnetGroupName: Match.anyValue(),
    });
    template.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('limits database ingress to a security group and does not open PostgreSQL publicly', () => {
    const template = createTemplate();
    const ingressRules = template.findResources('AWS::EC2::SecurityGroupIngress');
    const databaseRule = Object.values(ingressRules).find(
      (resource) => resource.Properties?.FromPort === 5432,
    );

    expect(databaseRule).toBeDefined();
    expect(databaseRule?.Properties?.SourceSecurityGroupId).toBeDefined();
    expect(databaseRule?.Properties?.CidrIp).toBeUndefined();
    expect(databaseRule?.Properties?.CidrIpv6).toBeUndefined();
  });

  test('creates a Fargate service using the generated database secret and Node port', () => {
    const template = createTemplate();
    const taskDefinitions = Object.values(
      template.findResources('AWS::ECS::TaskDefinition'),
    ).map((resource) => resource.Properties);
    const applicationTask = taskDefinitions.find((task) =>
      task.ContainerDefinitions?.some(
        (container: { Environment?: Array<{ Name: string }> }) =>
          container.Environment?.some(({ Name }) => Name === 'HOST'),
      ),
    );
    const migrationTask = taskDefinitions.find((task) =>
      task.ContainerDefinitions?.some(
        (container: { Command?: string[] }) =>
          container.Command?.includes('./scripts/migrate.mjs'),
      ),
    );

    template.hasResourceProperties('AWS::ECS::Service', {
      LaunchType: 'FARGATE',
      DesiredCount: 0,
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({
          AssignPublicIp: 'ENABLED',
        }),
      },
    });
    expect(taskDefinitions).toHaveLength(2);
    expect(applicationTask).toBeDefined();
    expect(migrationTask).toBeDefined();
    const appContainer = applicationTask?.ContainerDefinitions[0];
    const migrationContainer = migrationTask?.ContainerDefinitions[0];
    if (!appContainer || !migrationContainer) {
      throw new Error('Expected both application and migration containers.');
    }

    expect(appContainer.Environment).toEqual(
      expect.arrayContaining([
        { Name: 'HOST', Value: '0.0.0.0' },
        { Name: 'PORT', Value: '8080' },
        { Name: 'PGSSLMODE', Value: 'verify-full' },
        {
          Name: 'PGSSLROOTCERT',
          Value: '/etc/ssl/certs/rds-global-bundle.pem',
        },
      ]),
    );
    expect(appContainer.Secrets.map(({ Name }: { Name: string }) => Name)).toEqual(
      expect.arrayContaining(['PGUSER', 'PGPASSWORD']),
    );
    expect(
      appContainer.Secrets.some(({ Name }: { Name: string }) =>
        Name.startsWith('MIGRATION_'),
      ),
    ).toBe(false);
    expect(appContainer.PortMappings).toContainEqual(
      expect.objectContaining({ ContainerPort: 8080, Protocol: 'tcp' }),
    );

    expect(migrationContainer.Command).toEqual([
      'node',
      './scripts/migrate.mjs',
    ]);
    expect(
      migrationContainer.Secrets.map(({ Name }: { Name: string }) => Name),
    ).toEqual(
      expect.arrayContaining([
        'MIGRATION_PGUSER',
        'MIGRATION_PGPASSWORD',
        'APP_DATABASE_PASSWORD',
      ]),
    );
    expect(
      migrationContainer.Secrets.some(
        ({ Name }: { Name: string }) => Name === 'PGPASSWORD',
      ),
    ).toBe(false);

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 8080,
      Protocol: 'HTTP',
      TargetType: 'ip',
      HealthCheckPath: '/login',
    });
  });

  test('retains the ECR repository and enables HTTPS redirect when a certificate is configured', () => {
    const template = createTemplate({
      certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/test',
    });

    template.hasResourceProperties('AWS::ECR::Repository', {
      ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true },
    });
    template.hasResource('AWS::ECR::Repository', {
      DeletionPolicy: 'Retain',
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: Match.arrayWith([
        Match.objectLike({
          Type: 'redirect',
          RedirectConfig: Match.objectLike({
            Protocol: 'HTTPS',
            Port: '443',
          }),
        }),
      ]),
    });
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2);
  });

  test('retains database credentials and logs with bounded log retention', () => {
    const template = createTemplate();
    const secrets = Object.values(
      template.findResources('AWS::SecretsManager::Secret'),
    );
    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    );
    const appSecretPolicy = policies.find((policy) =>
      policy.Properties.Roles.some((role: { Ref: string }) =>
        role.Ref.includes('ApplicationTaskExecutionRole'),
      ),
    );
    const migrationSecretPolicy = policies.find((policy) =>
      policy.Properties.Roles.some((role: { Ref: string }) =>
        role.Ref.includes('MigrationTaskExecutionRole'),
      ),
    );

    expect(secrets).toHaveLength(2);
    expect(
      secrets.map((secret) => secret.Properties.GenerateSecretString.SecretStringTemplate),
    ).toEqual(
      expect.arrayContaining([
        JSON.stringify({ username: 'unibudget_admin' }),
        JSON.stringify({ username: 'unibudget_app' }),
      ]),
    );
    expect(secrets.every((secret) => secret.DeletionPolicy === 'Retain')).toBe(true);
    if (!appSecretPolicy || !migrationSecretPolicy) {
      throw new Error('Expected both task execution roles to have secret-read policies.');
    }
    const getSecretResources = (policy: (typeof policies)[number]) =>
      policy.Properties.PolicyDocument.Statement.filter(
        (statement: { Action: string[] }) =>
          statement.Action.includes('secretsmanager:GetSecretValue'),
      ).flatMap((statement: { Resource: { Ref: string } | { Ref: string }[] }) =>
        Array.isArray(statement.Resource)
          ? statement.Resource
          : [statement.Resource],
      );
    const appSecretResources = getSecretResources(appSecretPolicy);
    const migrationSecretResources = getSecretResources(migrationSecretPolicy);
    expect(appSecretResources).toHaveLength(1);
    expect(appSecretResources[0].Ref).toContain(
      'ApplicationDatabaseCredentials',
    );
    expect(migrationSecretResources).toHaveLength(2);
    expect(
      migrationSecretResources.some((resource: { Ref: string }) =>
        resource.Ref.includes('DatabaseAdminCredentials'),
      ),
    ).toBe(true);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 7,
    });
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Retain',
    });
  });
});
