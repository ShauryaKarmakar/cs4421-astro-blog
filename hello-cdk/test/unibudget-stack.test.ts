import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { UniBudgetStack } from '../lib/cdk-stack';

const testSupabaseHost = 'aws-0-eu-central-1.pooler.supabase.com';
const testPrefixListId = 'pl-0123456789abcdef0';

function createTemplate(props: ConstructorParameters<typeof UniBudgetStack>[2] = {}) {
  const app = new cdk.App();
  const stack = new UniBudgetStack(app, 'TestUniBudgetStack', {
    supabaseHost: testSupabaseHost,
    imageTag: 'test-image-tag',
    cloudFrontOriginPrefixListId: testPrefixListId,
    ...props,
  });
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

  test('creates a Fargate service using Supabase credentials and the database health check', () => {
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
        { Name: 'PGHOST', Value: testSupabaseHost },
        { Name: 'PGPORT', Value: '5432' },
        { Name: 'PGDATABASE', Value: 'postgres' },
        { Name: 'PGSSLMODE', Value: 'verify-full' },
      ]),
    );
    expect(
      appContainer.Environment?.some(
        ({ Name }: { Name: string }) => Name === 'PGSSLROOTCERT',
      ),
    ).toBe(false);
    expect(appContainer.Secrets.map(({ Name }: { Name: string }) => Name)).toEqual(
      expect.arrayContaining(['PGUSER', 'PGPASSWORD', 'SUPABASE_CA_CERT']),
    );
    expect(
      appContainer.Secrets.some(({ Name }: { Name: string }) =>
        Name.startsWith('MIGRATION_'),
      ),
    ).toBe(false);
    const secretLogicalId = (secretName: string): string => {
      const entry = Object.entries(
        template.findResources('AWS::SecretsManager::Secret'),
      ).find(([, resource]) => resource.Properties?.Name === secretName);
      if (!entry) {
        throw new Error(`Expected the stack to define the secret ${secretName}.`);
      }
      return entry[0];
    };
    const secretReference = (name: string) =>
      (
        appContainer.Secrets as Array<{ Name: string; ValueFrom?: unknown }>
      ).find((secret) => secret.Name === name)?.ValueFrom;

    const applicationSecretId = secretLogicalId('unibudget/supabase/application');
    const caSecretId = secretLogicalId('unibudget/supabase/ca');

    // The deployment workflow compares these references verbatim before it
    // migrates, so the rendered shape is part of the contract: a JSON-key
    // reference must end with :<key>:: and the CA must be the whole secret.
    expect(secretReference('PGUSER')).toEqual({
      'Fn::Join': ['', [{ Ref: applicationSecretId }, ':username::']],
    });
    expect(secretReference('PGPASSWORD')).toEqual({
      'Fn::Join': ['', [{ Ref: applicationSecretId }, ':password::']],
    });
    expect(secretReference('SUPABASE_CA_CERT')).toEqual({ Ref: caSecretId });
    expect(appContainer.PortMappings).toContainEqual(
      expect.objectContaining({ ContainerPort: 8080, Protocol: 'tcp' }),
    );
    // Liveness and readiness stay separate: the container probe must not
    // depend on PostgreSQL, while the target group keeps the database-backed
    // readiness path asserted above. A database outage therefore drains the
    // target group instead of making ECS replace healthy tasks.
    const livenessCommand = (appContainer.HealthCheck?.Command ?? []).join(' ');
    expect(livenessCommand).toContain('/api/live');
    expect(livenessCommand).not.toContain('/api/health');

    expect(migrationContainer.Command).toEqual([
      'node',
      './scripts/migrate.mjs',
    ]);
    expect(
      migrationContainer.Secrets.map(({ Name }: { Name: string }) => Name),
    ).toEqual(
      expect.arrayContaining([
        'PGUSER',
        'PGPASSWORD',
        'APP_DATABASE_PASSWORD',
        'SUPABASE_CA_CERT',
      ]),
    );
    expect(migrationContainer.Environment).toEqual(
      expect.arrayContaining([
        { Name: 'PGHOST', Value: testSupabaseHost },
        { Name: 'PGPORT', Value: '5432' },
        { Name: 'PGDATABASE', Value: 'postgres' },
        { Name: 'PGSSLMODE', Value: 'verify-full' },
      ]),
    );
    expect(
      migrationContainer.Environment?.some(
        ({ Name }: { Name: string }) => Name === 'PGSSLROOTCERT',
      ),
    ).toBe(false);

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 8080,
      Protocol: 'HTTP',
      TargetType: 'ip',
      HealthCheckPath: '/api/health',
      Matcher: { HttpCode: '200' },
    });
  });

  test('retains the ECR repository and keeps a single HTTP listener for the CloudFront origin', () => {
    const template = createTemplate();

    template.hasResourceProperties('AWS::ECR::Repository', {
      ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true },
    });
    template.hasResource('AWS::ECR::Repository', {
      DeletionPolicy: 'Retain',
    });
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: Match.arrayWith([Match.objectLike({ Type: 'forward' })]),
    });
  });

  test('serves HTTPS from the AWS-generated CloudFront hostname without a custom domain', () => {
    const template = createTemplate();
    const distributions = Object.values(
      template.findResources('AWS::CloudFront::Distribution'),
    );

    expect(distributions).toHaveLength(1);
    const config = distributions[0].Properties.DistributionConfig;
    expect(config.Enabled).toBe(true);
    expect(config.Aliases).toBeUndefined();
    expect(config.ViewerCertificate).toBeUndefined();
    expect(config.HttpVersion).toBe('http2and3');
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
  });

  test('forwards cookies, headers, and methods to the ALB without caching responses', () => {
    const template = createTemplate();
    const distributions = Object.values(
      template.findResources('AWS::CloudFront::Distribution'),
    );
    const config = distributions[0].Properties.DistributionConfig;
    const behavior = config.DefaultCacheBehavior;
    const origin = config.Origins[0];

    expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    expect(behavior.CachePolicyId).toBe(
      '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
    );
    expect(behavior.OriginRequestPolicyId).toBe(
      '216adef6-5c7f-47e4-b989-5492eafa07d3',
    );
    expect(behavior.AllowedMethods).toEqual([
      'GET',
      'HEAD',
      'OPTIONS',
      'PUT',
      'PATCH',
      'POST',
      'DELETE',
    ]);
    expect(origin.CustomOriginConfig.OriginProtocolPolicy).toBe('http-only');
    expect(origin.DomainName).toEqual({
      'Fn::GetAtt': [
        expect.stringContaining('ApplicationLoadBalancer'),
        'DNSName',
      ],
    });
  });

  test('allows the ALB only from the CloudFront origin-facing prefix list', () => {
    const template = createTemplate();
    const ingress = Object.values(
      template.findResources('AWS::EC2::SecurityGroupIngress'),
    );
    const httpRule = ingress.find((rule) => rule.Properties?.FromPort === 80);

    expect(httpRule?.Properties?.SourcePrefixListId).toBe(testPrefixListId);
    expect(httpRule?.Properties?.CidrIp).toBeUndefined();
    expect(httpRule?.Properties?.CidrIpv6).toBeUndefined();
    expect(ingress.some((rule) => rule.Properties?.FromPort === 443)).toBe(false);
  });

  test('preserves the CloudFront viewer address for authentication rate limiting', () => {
    const template = createTemplate();
    const loadBalancers = Object.values(
      template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'),
    );

    expect(loadBalancers[0].Properties.LoadBalancerAttributes).toEqual(
      expect.arrayContaining([
        { Key: 'routing.http.xff_header_processing.mode', Value: 'preserve' },
      ]),
    );
  });

  test('allows a running task count because CloudFront always provides HTTPS', () => {
    const template = createTemplate({ desiredCount: 2 });

    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 2 });
  });

  test('requires an explicit image tag and Supabase pooler hostname', () => {
    expect(() => createTemplate({ imageTag: undefined })).toThrow(
      /imageTag is required/,
    );
    expect(() => createTemplate({ supabaseHost: undefined })).toThrow(
      /supabaseHost is required/,
    );
    expect(() =>
      createTemplate({ supabaseHost: 'https://pooler.example.com' }),
    ).toThrow(/bare DNS hostname/);
  });

  test('requires the CloudFront origin-facing prefix list id', () => {
    expect(() =>
      createTemplate({ cloudFrontOriginPrefixListId: undefined }),
    ).toThrow(/cloudFrontOriginPrefixListId is required/);
    expect(() =>
      createTemplate({ cloudFrontOriginPrefixListId: 'https://cloudfront.net' }),
    ).toThrow(/managed prefix list ID/);
  });

  test('derives the public URL from the CloudFront distribution output', () => {
    const template = createTemplate();
    const outputs = template.findOutputs('*');

    expect(outputs.ApplicationUrl?.Value).toEqual({
      'Fn::Join': [
        '',
        [
          'https://',
          {
            'Fn::GetAtt': [
              expect.stringContaining('ApplicationDistribution'),
              'DomainName',
            ],
          },
        ],
      ],
    });
    expect(outputs.CloudFrontDistributionId?.Value).toEqual({
      Ref: expect.stringContaining('ApplicationDistribution'),
    });
    expect(outputs.CloudFrontDomainName?.Value).toEqual({
      'Fn::GetAtt': [
        expect.stringContaining('ApplicationDistribution'),
        'DomainName',
      ],
    });
    expect(outputs.LoadBalancerDnsName?.Value).toBeDefined();
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

    expect(secrets).toHaveLength(5);
    const generatedSecrets = secrets.filter(
      (secret) => secret.Properties.GenerateSecretString?.SecretStringTemplate,
    );
    expect(generatedSecrets).toHaveLength(2);
    expect(
      generatedSecrets.map(
        (secret) => secret.Properties.GenerateSecretString.SecretStringTemplate,
      ),
    ).toEqual(
      expect.arrayContaining([
        JSON.stringify({ username: 'unibudget_admin' }),
        JSON.stringify({ username: 'unibudget_app' }),
      ]),
    );
    expect(
      secrets
        .filter((secret) => secret.Properties.Name)
        .map((secret) => secret.Properties.Name),
    ).toEqual(
      expect.arrayContaining([
        'unibudget/supabase/application',
        'unibudget/supabase/migration',
        'unibudget/supabase/ca',
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
    expect(appSecretResources).toHaveLength(2);
    expect(
      appSecretResources.some((resource: { Ref: string }) =>
        resource.Ref.includes('SupabaseApplicationCredentials'),
      ),
    ).toBe(true);
    expect(
      appSecretResources.some((resource: { Ref: string }) =>
        resource.Ref.includes('SupabaseCaCertificate'),
      ),
    ).toBe(true);
    expect(migrationSecretResources).toHaveLength(3);
    expect(
      migrationSecretResources.some((resource: { Ref: string }) =>
        resource.Ref.includes('SupabaseMigrationCredentials'),
      ),
    ).toBe(true);
    expect(
      migrationSecretResources.some((resource: { Ref: string }) =>
        resource.Ref.includes('SupabaseApplicationCredentials'),
      ),
    ).toBe(true);
    expect(
      migrationSecretResources.some((resource: { Ref: string }) =>
        resource.Ref.includes('SupabaseCaCertificate'),
      ),
    ).toBe(true);
    expect(
      migrationSecretResources.some((resource: { Ref: string }) =>
        resource.Ref.includes('DatabaseAdminCredentials'),
      ),
    ).toBe(false);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 7,
    });
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Retain',
    });
  });

  test('outputs exact role and secret ARNs used by workflow validation', () => {
    const template = createTemplate();
    const outputs = template.findOutputs('*');

    for (const name of [
      'ApplicationTaskRoleArn',
      'ApplicationTaskExecutionRoleArn',
      'MigrationTaskRoleArn',
      'MigrationTaskExecutionRoleArn',
      'SupabaseApplicationSecretArn',
      'SupabaseMigrationSecretArn',
      'SupabaseCaSecretArn',
    ]) {
      expect(outputs[name]?.Value).toBeDefined();
    }

    expect(outputs.ApplicationTaskRoleArn?.Value).toEqual({
      'Fn::GetAtt': [
        expect.stringContaining('ApplicationTaskTaskRole'),
        'Arn',
      ],
    });
    expect(outputs.ApplicationTaskExecutionRoleArn?.Value).toEqual({
      'Fn::GetAtt': [
        expect.stringContaining('ApplicationTaskExecutionRole'),
        'Arn',
      ],
    });
    expect(outputs.MigrationTaskRoleArn?.Value).toEqual({
      'Fn::GetAtt': [expect.stringContaining('MigrationTaskTaskRole'), 'Arn'],
    });
    expect(outputs.MigrationTaskExecutionRoleArn?.Value).toEqual({
      'Fn::GetAtt': [
        expect.stringContaining('MigrationTaskExecutionRole'),
        'Arn',
      ],
    });
    expect(outputs.SupabaseApplicationSecretArn?.Value).toEqual({
      Ref: expect.stringContaining('SupabaseApplicationCredentials'),
    });
    expect(outputs.SupabaseMigrationSecretArn?.Value).toEqual({
      Ref: expect.stringContaining('SupabaseMigrationCredentials'),
    });
    expect(outputs.SupabaseCaSecretArn?.Value).toEqual({
      Ref: expect.stringContaining('SupabaseCaCertificate'),
    });
  });
});
