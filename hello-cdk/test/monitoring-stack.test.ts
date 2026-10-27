import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { UniBudgetMonitoringStack } from '../lib/monitoring-stack';

const TOPIC_ARN =
  'arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms';
const LOAD_BALANCER_FULL_NAME =
  'app/UniBud-Appli-p0ktuGjGHELm/af860c4c877d7051';
const TARGET_GROUP_FULL_NAME =
  'targetgroup/UniBud-Appli-S7VNWXHA2XLE/b3a50584777d8e95';

const baseProps: ConstructorParameters<typeof UniBudgetMonitoringStack>[2] = {
  alarmTopicArn: TOPIC_ARN,
  loadBalancerFullName: LOAD_BALANCER_FULL_NAME,
  targetGroupFullName: TARGET_GROUP_FULL_NAME,
  clusterName: 'UniBudgetStack-ApplicationClusterC783CD56-hXQUSkONBCXV',
  serviceName: 'UniBudgetStack-ApplicationService423C69C6-YCFTDtV8bRhX',
  desiredCount: 1,
};

function createTemplate(
  overrides: Partial<typeof baseProps> = {},
): Template {
  const app = new cdk.App();
  const stack = new UniBudgetMonitoringStack(
    app,
    'UniBudgetStack-Monitoring',
    { ...baseProps, ...overrides },
  );
  return Template.fromStack(stack);
}

type AlarmProperties = {
  AlarmName?: string;
  AlarmDescription?: string;
  AlarmActions?: unknown[];
  MetricName?: string;
  Namespace?: string;
  Statistic?: string;
  Period?: number;
  Dimensions?: Array<{ Name: string; Value: string }>;
  Threshold?: number;
  EvaluationPeriods?: number;
  ComparisonOperator?: string;
  TreatMissingData?: string;
};

function alarms(template: Template): AlarmProperties[] {
  return Object.values(
    template.findResources('AWS::CloudWatch::Alarm'),
  ).map((resource) => resource.Properties as AlarmProperties);
}

function alarmFor(template: Template, metricName: string): AlarmProperties {
  const alarm = alarms(template).find(
    (candidate) => candidate.MetricName === metricName,
  );
  if (!alarm) {
    throw new Error(`No alarm found for metric ${metricName}`);
  }
  return alarm;
}

describe('UniBudgetMonitoringStack', () => {
  test('creates only the five alarms and the two metric filters', () => {
    const template = createTemplate();

    template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    template.resourceCountIs('AWS::Logs::MetricFilter', 2);

    for (const type of [
      'AWS::ECS::Service',
      'AWS::ECS::TaskDefinition',
      'AWS::ECR::Repository',
      'AWS::IAM::Policy',
      'AWS::IAM::Role',
      'AWS::SNS::Topic',
      'AWS::Logs::LogGroup',
    ]) {
      template.resourceCountIs(type, 0);
    }
  });

  test('uses a stack name that matches the existing SNS topic policy prefix', () => {
    const app = new cdk.App();
    const stack = new UniBudgetMonitoringStack(
      app,
      'UniBudgetStack-Monitoring',
      baseProps,
    );

    expect(stack.stackName).toBe('UniBudgetStack-Monitoring');
  });

  test('uses alarm names covered by the existing SNS topic policy', () => {
    const names = alarms(createTemplate())
      .map((alarm) => alarm.AlarmName)
      .sort();

    expect(names).toEqual([
      'UniBudgetStack-Monitoring-LiveTaskCount',
      'UniBudgetStack-Monitoring-Request5xx',
      'UniBudgetStack-Monitoring-StructuredErrors',
      'UniBudgetStack-Monitoring-Target5xx',
      'UniBudgetStack-Monitoring-UnhealthyTargets',
    ]);
    for (const name of names) {
      expect(name).toMatch(/^UniBudgetStack-/);
    }
  });

  test('attaches the metric filter to the existing application log group', () => {
    const template = createTemplate();

    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      LogGroupName: '/unibudget/ecs/application',
      FilterPattern: '{ $.level = "error" }',
      MetricTransformations: [
        {
          MetricNamespace: 'UniBudget/Application',
          MetricName: 'StructuredErrorCount',
          MetricValue: '1',
          DefaultValue: 0,
        },
      ],
    });
  });

  test('counts 5xx access records, which the error filter cannot see', () => {
    const template = createTemplate();

    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      LogGroupName: '/unibudget/ecs/application',
      FilterPattern: '{ $.status >= 500 }',
      MetricTransformations: [
        {
          MetricNamespace: 'UniBudget/Application',
          MetricName: 'Http5xxCount',
          MetricValue: '1',
          DefaultValue: 0,
        },
      ],
    });
  });

  test('request 5xx alarm trips on the first failing minute', () => {
    const alarm = alarmFor(createTemplate(), 'Http5xxCount');

    expect(alarm).toMatchObject({
      Namespace: 'UniBudget/Application',
      Statistic: 'Sum',
      Period: 60,
      Threshold: 0,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
    expect(alarm.Dimensions).toBeUndefined();
  });

  test('sends every alarm to the imported SNS topic', () => {
    const template = createTemplate();

    for (const alarm of alarms(template)) {
      expect(alarm.AlarmActions).toEqual([TOPIC_ARN]);
    }
  });

  test('target 5XX alarm uses the ALB and target-group dimensions', () => {
    const alarm = alarmFor(createTemplate(), 'HTTPCode_Target_5XX_Count');

    expect(alarm).toMatchObject({
      Namespace: 'AWS/ApplicationELB',
      Statistic: 'Sum',
      Period: 300,
      Threshold: 5,
      EvaluationPeriods: 2,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
    expect(alarm.Dimensions).toEqual(
      expect.arrayContaining([
        { Name: 'LoadBalancer', Value: LOAD_BALANCER_FULL_NAME },
        { Name: 'TargetGroup', Value: TARGET_GROUP_FULL_NAME },
      ]),
    );
  });

  test('unhealthy-target alarm trips on any unhealthy target', () => {
    const alarm = alarmFor(createTemplate(), 'UnHealthyHostCount');

    expect(alarm).toMatchObject({
      Namespace: 'AWS/ApplicationELB',
      Statistic: 'Maximum',
      Period: 60,
      Threshold: 0,
      EvaluationPeriods: 2,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
    expect(alarm.Dimensions).toEqual(
      expect.arrayContaining([
        { Name: 'LoadBalancer', Value: LOAD_BALANCER_FULL_NAME },
        { Name: 'TargetGroup', Value: TARGET_GROUP_FULL_NAME },
      ]),
    );
  });

  test('live-task alarm tracks the ECS service dimensions and desired count', () => {
    const alarm = alarmFor(createTemplate(), 'LiveTaskCount');

    expect(alarm).toMatchObject({
      Namespace: 'AWS/ECS',
      Statistic: 'Average',
      Period: 60,
      Threshold: 1,
      EvaluationPeriods: 3,
      ComparisonOperator: 'LessThanThreshold',
      TreatMissingData: 'breaching',
    });
    expect(alarm.Dimensions).toEqual(
      expect.arrayContaining([
        { Name: 'ClusterName', Value: baseProps.clusterName },
        { Name: 'ServiceName', Value: baseProps.serviceName },
      ]),
    );
  });

  test('structured-error alarm uses the custom metric with missing data treated as healthy', () => {
    const alarm = alarmFor(createTemplate(), 'StructuredErrorCount');

    expect(alarm).toMatchObject({
      Namespace: 'UniBudget/Application',
      Statistic: 'Sum',
      Period: 300,
      Threshold: 5,
      EvaluationPeriods: 2,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
    expect(alarm.Dimensions).toBeUndefined();
  });

  test('rejects malformed resource identifiers', () => {
    expect(() =>
      createTemplate({ loadBalancerFullName: 'loadbalancer/app/name/id' }),
    ).toThrow('loadBalancerFullName');
    expect(() =>
      createTemplate({ targetGroupFullName: 'name/id' }),
    ).toThrow('targetGroupFullName');
    expect(() => createTemplate({ clusterName: 'bad name' })).toThrow(
      'clusterName',
    );
    expect(() => createTemplate({ desiredCount: 0 })).toThrow(
      'desiredCount',
    );
    expect(() =>
      createTemplate({ alarmTopicArn: 'not-an-arn' }),
    ).toThrow('alarmTopicArn');
  });

  test('can override the log group name without creating a log group', () => {
    const template = createTemplate({ logGroupName: '/custom/application' });

    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      LogGroupName: '/custom/application',
    });
    template.resourceCountIs('AWS::Logs::LogGroup', 0);
  });

});
