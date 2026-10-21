import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface UniBudgetStackProps extends cdk.StackProps {
  certificateArn?: string;
  desiredCount?: number;
  imageTag?: string;
}

export class UniBudgetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UniBudgetStackProps = {}) {
    super(scope, id, props);

    const desiredCount = props.desiredCount ?? 0;
    const imageTag = props.imageTag ?? 'bootstrap';
    if (!Number.isInteger(desiredCount) || desiredCount < 0) {
      throw new Error('desiredCount must be a non-negative integer.');
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(imageTag)) {
      throw new Error('imageTag must be a valid container image tag.');
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
    applicationDatabaseSecret.grantRead(applicationExecutionRole);
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
        PGHOST: database.dbInstanceEndpointAddress,
        PGPORT: database.dbInstanceEndpointPort,
        PGDATABASE: 'unibudget',
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: '/etc/ssl/certs/rds-global-bundle.pem',
      },
      secrets: {
        PGUSER: ecs.Secret.fromSecretsManager(applicationDatabaseSecret, 'username'),
        PGPASSWORD: ecs.Secret.fromSecretsManager(applicationDatabaseSecret, 'password'),
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
          "fetch('http://127.0.0.1:8080/login').then((response) => process.exit(response.status < 500 ? 0 : 1)).catch(() => process.exit(1))",
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
    databaseAdminSecret.grantRead(migrationExecutionRole);
    applicationDatabaseSecret.grantRead(migrationExecutionRole);
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
        MIGRATION_PGHOST: database.dbInstanceEndpointAddress,
        MIGRATION_PGPORT: database.dbInstanceEndpointPort,
        MIGRATION_PGDATABASE: 'unibudget',
        MIGRATION_PGSSLMODE: 'verify-full',
        MIGRATION_PGSSLROOTCERT: '/etc/ssl/certs/rds-global-bundle.pem',
      },
      secrets: {
        MIGRATION_PGUSER: ecs.Secret.fromSecretsManager(
          databaseAdminSecret,
          'username',
        ),
        MIGRATION_PGPASSWORD: ecs.Secret.fromSecretsManager(
          databaseAdminSecret,
          'password',
        ),
        APP_DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(
          applicationDatabaseSecret,
          'password',
        ),
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
    });
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'ApplicationTargets', {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/login',
        healthyHttpCodes: '200-399',
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

    if (props.certificateArn) {
      loadBalancerSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(443),
        'HTTPS from the internet.',
      );
      loadBalancer.addListener('HttpListener', {
        port: 80,
        open: false,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
      loadBalancer.addListener('HttpsListener', {
        port: 443,
        open: false,
        certificates: [
          elbv2.ListenerCertificate.fromArn(props.certificateArn),
        ],
        defaultTargetGroups: [targetGroup],
      });
    } else {
      loadBalancerSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80),
        'HTTP from the internet for a demonstration deployment.',
      );
      loadBalancer.addListener('HttpListener', {
        port: 80,
        open: false,
        defaultTargetGroups: [targetGroup],
      });
    }

    new cdk.CfnOutput(this, 'ApplicationUrl', {
      value: `${props.certificateArn ? 'https' : 'http'}://${loadBalancer.loadBalancerDnsName}`,
    });
    new cdk.CfnOutput(this, 'ImageRepositoryUri', { value: repository.repositoryUri });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'TaskDefinitionArn', { value: taskDefinition.taskDefinitionArn });
    new cdk.CfnOutput(this, 'MigrationTaskDefinitionArn', {
      value: migrationTaskDefinition.taskDefinitionArn,
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
  }
}
