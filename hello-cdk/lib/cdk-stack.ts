import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

function createEmptySecret(
  scope: Construct,
  id: string,
  secretName: string,
  description: string,
): secretsmanager.Secret {
  const secret = new secretsmanager.Secret(scope, id, {
    secretName,
    description,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  // The L2 construct defaults to generating a placeholder value. Remove it so
  // CloudFormation creates an empty secret that is populated out of band; no
  // placeholder credentials are created.
  const cfnSecret = secret.node.defaultChild as secretsmanager.CfnSecret;
  cfnSecret.generateSecretString = undefined;
  return secret;
}

export interface UniBudgetStackProps extends cdk.StackProps {
  desiredCount?: number;
  imageTag?: string;
  supabaseHost?: string;
  supabasePort?: string;
  supabaseDatabase?: string;
  cloudFrontOriginPrefixListId?: string;
}

function isValidDnsHostname(value: string): boolean {
  if (value.length > 253 || value.endsWith('.')) {
    return false;
  }
  const labels = value.split('.');
  return labels.every((label) =>
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
  );
}

export class UniBudgetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UniBudgetStackProps = {}) {
    super(scope, id, props);

    const desiredCount = props.desiredCount ?? 0;
    const imageTag = props.imageTag?.trim();
    if (!Number.isInteger(desiredCount) || desiredCount < 0) {
      throw new Error('desiredCount must be a non-negative integer.');
    }
    if (!imageTag) {
      throw new Error(
        'imageTag is required; both task definitions must reference an image tag that will be pushed.',
      );
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(imageTag)) {
      throw new Error('imageTag must be a valid container image tag.');
    }
    // Never default the pooler hostname. Supabase has regional and
    // project-specific pooler hosts, and a stale default silently connects to
    // the wrong tenant (or not at all). Require the exact host copied from the
    // project's Database Settings.
    const supabaseHost = props.supabaseHost?.trim();
    const supabasePort = props.supabasePort ?? '5432';
    const supabaseDatabase = props.supabaseDatabase?.trim() ?? 'postgres';
    if (!supabaseHost) {
      throw new Error(
        'supabaseHost is required. Copy the session-pooler host from the Supabase dashboard Database Settings.',
      );
    }
    if (!isValidDnsHostname(supabaseHost)) {
      throw new Error(
        'supabaseHost must be a bare DNS hostname copied from the Supabase dashboard (no scheme, port, or path).',
      );
    }
    if (!supabaseDatabase) {
      throw new Error('supabaseDatabase must be set for the Supabase connection.');
    }
    if (!/^[0-9]{1,5}$/.test(supabasePort) || Number(supabasePort) < 1 || Number(supabasePort) > 65535) {
      throw new Error('supabasePort must be a numeric PostgreSQL port between 1 and 65535.');
    }

    // HTTPS is terminated by CloudFront with its default *.cloudfront.net
    // certificate, so no custom domain or ACM certificate is required. The
    // ALB itself stays on HTTP and accepts connections only from the
    // AWS-managed CloudFront origin-facing prefix list: that rule is what keeps
    // authenticated traffic from bypassing HTTPS by reaching the ALB directly.
    const cloudFrontOriginPrefixListId = props.cloudFrontOriginPrefixListId?.trim();
    if (!cloudFrontOriginPrefixListId) {
      throw new Error(
        'cloudFrontOriginPrefixListId is required: the ALB accepts traffic only from the CloudFront origin-facing prefix list.',
      );
    }
    if (!/^pl-[0-9a-f]{8,32}$/.test(cloudFrontOriginPrefixListId)) {
      throw new Error(
        'cloudFrontOriginPrefixListId must be an EC2 managed prefix list ID such as pl-0123456789abcdef0.',
      );
    }

    const vpc = new ec2.Vpc(this, 'ApplicationVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    const applicationSecurityGroup = new ec2.SecurityGroup(
      this,
      'ApplicationSecurityGroup',
      {
        vpc,
        description: 'Allow application traffic only from the load balancer.',
        allowAllOutbound: true,
      },
    );
    const loadBalancerSecurityGroup = new ec2.SecurityGroup(
      this,
      'LoadBalancerSecurityGroup',
      {
        vpc,
        description: 'Public HTTP or HTTPS ingress to the application load balancer.',
        allowAllOutbound: true,
      },
    );
    const databaseSecurityGroup = new ec2.SecurityGroup(
      this,
      'DatabaseSecurityGroup',
      {
        vpc,
        description: 'Allow PostgreSQL only from application tasks.',
        allowAllOutbound: false,
      },
    );
    databaseSecurityGroup.addIngressRule(
      applicationSecurityGroup,
      ec2.Port.tcp(5432),
      'PostgreSQL from the application tier.',
    );

    const databaseAdminSecret = new secretsmanager.Secret(
      this,
      'DatabaseAdminCredentials',
      {
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: 'unibudget_admin' }),
          generateStringKey: 'password',
          excludePunctuation: true,
        },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const applicationDatabaseSecret = new secretsmanager.Secret(
      this,
      'ApplicationDatabaseCredentials',
      {
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: 'unibudget_app' }),
          generateStringKey: 'password',
          excludePunctuation: true,
        },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );

    // Supabase credentials are populated out of band after the first
    // deployment. The application secret holds { username, password } where the
    // username includes the pooler project ref; the migration secret holds the
    // postgres administrator username and password. The CA secret holds the PEM
    // certificate downloaded from the project's Database Settings.
    const supabaseApplicationSecret = createEmptySecret(
      this,
      'SupabaseApplicationCredentials',
      'unibudget/supabase/application',
      'JSON with the unibudget_app pooler username and password for Supabase.',
    );
    const supabaseMigrationSecret = createEmptySecret(
      this,
      'SupabaseMigrationCredentials',
      'unibudget/supabase/migration',
      'JSON with the Supabase postgres administrator username and password.',
    );
    const supabaseCaSecret = createEmptySecret(
      this,
      'SupabaseCaCertificate',
      'unibudget/supabase/ca',
      'PEM CA certificate downloaded from the Supabase project database settings.',
    );

    const repository = new ecr.Repository(this, 'ApplicationRepository', {
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 5 }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const database = new rds.DatabaseInstance(this, 'ApplicationDatabase', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_3,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      credentials: rds.Credentials.fromSecret(
        databaseAdminSecret,
        'unibudget_admin',
      ),
      databaseName: 'unibudget',
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      publiclyAccessible: false,
      multiAz: false,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoMinorVersionUpgrade: true,
    });
    const cluster = new ecs.Cluster(this, 'ApplicationCluster', { vpc });
    const logGroup = new logs.LogGroup(this, 'ApplicationLogs', {
      logGroupName: '/unibudget/ecs/application',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const applicationExecutionRole = new iam.Role(
      this,
      'ApplicationTaskExecutionRole',
      {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description:
          'Pull the application image, write logs, and retrieve app database credentials.',
      },
    );
    repository.grantPull(applicationExecutionRole);
    supabaseApplicationSecret.grantRead(applicationExecutionRole);
    supabaseCaSecret.grantRead(applicationExecutionRole);
    logGroup.grantWrite(applicationExecutionRole);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'ApplicationTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole: applicationExecutionRole,
    });
    const container = taskDefinition.addContainer('ApplicationContainer', {
      image: ecs.ContainerImage.fromEcrRepository(repository, imageTag),
      environment: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: '8080',
        PGHOST: supabaseHost,
        PGPORT: supabasePort,
        PGDATABASE: supabaseDatabase,
        PGSSLMODE: 'verify-full',
      },
      secrets: {
        PGUSER: ecs.Secret.fromSecretsManager(
          supabaseApplicationSecret,
          'username',
        ),
        PGPASSWORD: ecs.Secret.fromSecretsManager(
          supabaseApplicationSecret,
          'password',
        ),
        SUPABASE_CA_CERT: ecs.Secret.fromSecretsManager(supabaseCaSecret),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'application',
      }),
      healthCheck: {
        command: [
          'CMD',
          'node',
          '-e',
          "fetch('http://127.0.0.1:8080/api/health').then((response) => process.exit(response.status === 200 ? 0 : 1)).catch(() => process.exit(1))",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(40),
      },
      stopTimeout: cdk.Duration.seconds(30),
    });
    container.addPortMappings({ containerPort: 8080, protocol: ecs.Protocol.TCP });

    const migrationExecutionRole = new iam.Role(
      this,
      'MigrationTaskExecutionRole',
      {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description:
          'Pull the migration image, write logs, and retrieve database setup credentials.',
      },
    );
    repository.grantPull(migrationExecutionRole);
    supabaseMigrationSecret.grantRead(migrationExecutionRole);
    supabaseApplicationSecret.grantRead(migrationExecutionRole);
    supabaseCaSecret.grantRead(migrationExecutionRole);
    logGroup.grantWrite(migrationExecutionRole);

    const migrationTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'MigrationTask',
      {
        cpu: 256,
        memoryLimitMiB: 512,
        executionRole: migrationExecutionRole,
      },
    );
    migrationTaskDefinition.addContainer('MigrationContainer', {
      image: ecs.ContainerImage.fromEcrRepository(repository, imageTag),
      command: ['node', './scripts/migrate.mjs'],
      environment: {
        NODE_ENV: 'production',
        PGHOST: supabaseHost,
        PGPORT: supabasePort,
        PGDATABASE: supabaseDatabase,
        PGSSLMODE: 'verify-full',
      },
      secrets: {
        PGUSER: ecs.Secret.fromSecretsManager(
          supabaseMigrationSecret,
          'username',
        ),
        PGPASSWORD: ecs.Secret.fromSecretsManager(
          supabaseMigrationSecret,
          'password',
        ),
        APP_DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(
          supabaseApplicationSecret,
          'password',
        ),
        SUPABASE_CA_CERT: ecs.Secret.fromSecretsManager(supabaseCaSecret),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'migration',
      }),
      stopTimeout: cdk.Duration.seconds(30),
    });

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ApplicationLoadBalancer', {
      vpc,
      internetFacing: true,
      securityGroup: loadBalancerSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // CloudFront appends the viewer IP to X-Forwarded-For and the ALB would
      // normally append the CloudFront edge IP after it. Preserving the header
      // keeps the viewer IP last, which is what src/lib/rateLimiter.ts trusts,
      // so authentication rate limits stay per user instead of per edge.
      xffHeaderProcessingMode: elbv2.XffHeaderProcessingMode.PRESERVE,
    });
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'ApplicationTargets', {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/api/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    const service = new ecs.FargateService(this, 'ApplicationService', {
      cluster,
      taskDefinition,
      desiredCount,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [applicationSecurityGroup],
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      enableExecuteCommand: false,
    });
    service.attachToApplicationTargetGroup(targetGroup);
    applicationSecurityGroup.addIngressRule(
      loadBalancerSecurityGroup,
      ec2.Port.tcp(8080),
      'Application requests from the load balancer.',
    );

    // No 0.0.0.0/0 rule: the ALB is reachable only from CloudFront's
    // origin-facing servers, so plain HTTP cannot be used to bypass the HTTPS
    // endpoint and submit credentials or session cookies directly.
    loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(cloudFrontOriginPrefixListId),
      ec2.Port.tcp(80),
      'HTTP from the CloudFront origin-facing prefix list only.',
    );
    loadBalancer.addListener('HttpListener', {
      port: 80,
      open: false,
      defaultTargetGroups: [targetGroup],
    });

    // CloudFront terminates TLS with its AWS-managed certificate on the
    // generated *.cloudfront.net hostname, so no certificate, DNS record, or
    // custom domain is needed. Every viewer request is redirected to HTTPS.
    // Caching is disabled for the whole distribution: Astro renders per-user
    // HTML and the same host serves login, session, and budget APIs, so no
    // response may be shared between viewers. AllViewer forwards every viewer
    // header (including Host), all cookies (the session cookie), and all query
    // strings, and all HTTP methods are allowed for the API routes.
    const distribution = new cloudfront.Distribution(this, 'ApplicationDistribution', {
      comment: 'UniBudget SSR delivery through the AWS-generated CloudFront hostname.',
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: new origins.HttpOrigin(loadBalancer.loadBalancerDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          connectionAttempts: 3,
          readTimeout: cdk.Duration.seconds(30),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        compress: true,
      },
    });

    // The public URL is derived from the distribution, never supplied by hand.
    new cdk.CfnOutput(this, 'ApplicationUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description:
        'Public HTTPS origin on the AWS-generated CloudFront hostname; no custom domain is required.',
    });
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
    });
    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'LoadBalancerDnsName', {
      value: loadBalancer.loadBalancerDnsName,
      description:
        'CloudFront origin only. The load balancer security group rejects traffic that is not from CloudFront.',
    });
    new cdk.CfnOutput(this, 'ImageRepositoryUri', { value: repository.repositoryUri });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: service.serviceName });
    new cdk.CfnOutput(this, 'TaskDefinitionArn', { value: taskDefinition.taskDefinitionArn });
    new cdk.CfnOutput(this, 'ApplicationTaskRoleArn', {
      value: taskDefinition.taskRole.roleArn,
    });
    new cdk.CfnOutput(this, 'ApplicationTaskExecutionRoleArn', {
      value: applicationExecutionRole.roleArn,
    });
    new cdk.CfnOutput(this, 'MigrationTaskDefinitionArn', {
      value: migrationTaskDefinition.taskDefinitionArn,
    });
    new cdk.CfnOutput(this, 'MigrationTaskRoleArn', {
      value: migrationTaskDefinition.taskRole.roleArn,
    });
    new cdk.CfnOutput(this, 'MigrationTaskExecutionRoleArn', {
      value: migrationExecutionRole.roleArn,
    });
    new cdk.CfnOutput(this, 'SupabaseApplicationSecretArn', {
      value: supabaseApplicationSecret.secretArn,
    });
    new cdk.CfnOutput(this, 'SupabaseMigrationSecretArn', {
      value: supabaseMigrationSecret.secretArn,
    });
    new cdk.CfnOutput(this, 'SupabaseCaSecretArn', {
      value: supabaseCaSecret.secretArn,
    });
    new cdk.CfnOutput(this, 'ApplicationSecurityGroupId', {
      value: applicationSecurityGroup.securityGroupId,
    });
    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: cdk.Fn.join(',', vpc.publicSubnets.map((subnet) => subnet.subnetId)),
    });
    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: database.dbInstanceEndpointAddress,
    });
    new cdk.CfnOutput(this, 'RetainedApplicationDatabaseSecretArn', {
      value: applicationDatabaseSecret.secretArn,
      description:
        'Retained RDS-era application secret; the Supabase tasks do not read it.',
    });
  }
}
