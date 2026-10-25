import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface UniBudgetMonitoringStackProps extends cdk.StackProps {
  /**
   * Existing SNS topic. The stack imports it and never creates or replaces it.
   */
  readonly alarmTopicArn: string;
  /**
   * ALB CloudWatch dimension value, for example `app/my-alb/1234567890abcdef`.
   */
  readonly loadBalancerFullName: string;
  /**
   * Target-group CloudWatch dimension value, for example
   * `targetgroup/my-target-group/1234567890abcdef`.
   */
  readonly targetGroupFullName: string;
  readonly clusterName: string;
  readonly serviceName: string;
  readonly desiredCount: number;
  readonly logGroupName?: string;
}

const DEFAULT_LOG_GROUP_NAME = '/unibudget/ecs/application';
const ALARM_NAME_PREFIX = 'UniBudgetStack-Monitoring';

function assertMatches(value: string, pattern: RegExp, field: string): void {
  if (!pattern.test(value)) {
    throw new Error(`${field} has an unexpected format: ${value}`);
  }
}

/**
 * Monitoring-only stack.
 *
 * The application stack is deliberately not updated here: importing the log
 * group, target-group dimensions and SNS topic keeps this stack independent of
 * ECS, ECR, IAM and the application task definitions. The stack name must stay
 * under the `UniBudgetStack-*` prefix so the existing SNS topic policy's
 * `SourceArn` condition continues to authorise its alarms.
 */
export class UniBudgetMonitoringStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: UniBudgetMonitoringStackProps,
  ) {
    super(scope, id, props);

    assertMatches(
      props.alarmTopicArn,
      /^arn:aws:sns:[a-z0-9-]+:\d{12}:[-A-Za-z0-9_]+$/,
      'alarmTopicArn',
    );
    assertMatches(
      props.loadBalancerFullName,
      /^app\/[-A-Za-z0-9]+\/[-A-Za-z0-9]+$/,
      'loadBalancerFullName',
    );
    assertMatches(
      props.targetGroupFullName,
      /^targetgroup\/[-A-Za-z0-9]+\/[-A-Za-z0-9]+$/,
      'targetGroupFullName',
    );
    assertMatches(props.clusterName, /^[-A-Za-z0-9_]+$/, 'clusterName');
    assertMatches(props.serviceName, /^[-A-Za-z0-9_]+$/, 'serviceName');
    if (!Number.isInteger(props.desiredCount) || props.desiredCount < 1) {
      throw new Error('desiredCount must be a positive integer');
    }

    const logGroupName = props.logGroupName ?? DEFAULT_LOG_GROUP_NAME;
    assertMatches(logGroupName, /^\/[-A-Za-z0-9._/#]+$/, 'logGroupName');

    const topic = sns.Topic.fromTopicArn(
      this,
      'ImportedAlarmTopic',
      props.alarmTopicArn,
    );
    const notify = new cloudwatchActions.SnsAction(topic);

    // Filter the application's structured JSON logs. This attaches a metric
    // filter to the existing log group; it does not create a new log group.
    const applicationLogGroup = logs.LogGroup.fromLogGroupName(
      this,
      'ImportedApplicationLogGroup',
      logGroupName,
    );
    new logs.MetricFilter(this, 'ApplicationErrorMetricFilter', {
      logGroup: applicationLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'error'),
      metricNamespace: 'UniBudget/Application',
      metricName: 'StructuredErrorCount',
      defaultValue: 0,
    });

    const target5xx = new cloudwatch.Alarm(this, 'Target5xxAlarm', {
      alarmName: `${ALARM_NAME_PREFIX}-Target5xx`,
      alarmDescription:
        'More than five 5XX responses from the application targets in ten minutes',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'HTTPCode_Target_5XX_Count',
        dimensionsMap: {
          LoadBalancer: props.loadBalancerFullName,
          TargetGroup: props.targetGroupFullName,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    target5xx.addAlarmAction(notify);

    const unhealthyTargets = new cloudwatch.Alarm(this, 'UnhealthyTargetsAlarm', {
      alarmName: `${ALARM_NAME_PREFIX}-UnhealthyTargets`,
      alarmDescription:
        'The target group reported an unhealthy target for two consecutive minutes',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'UnHealthyHostCount',
        dimensionsMap: {
          LoadBalancer: props.loadBalancerFullName,
          TargetGroup: props.targetGroupFullName,
        },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 0,
      evaluationPeriods: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    unhealthyTargets.addAlarmAction(notify);

    // ECS service utilization metrics publish LiveTaskCount without requiring
    // Container Insights. RunningTaskCount only exists when Container Insights
    // is enabled, so it is not a reliable baseline signal for this service.
    const liveTasks = new cloudwatch.Alarm(this, 'LiveTaskCountAlarm', {
      alarmName: `${ALARM_NAME_PREFIX}-LiveTaskCount`,
      alarmDescription: `Live task count stayed below the desired count of ${props.desiredCount} for three consecutive minutes`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'LiveTaskCount',
        dimensionsMap: {
          ClusterName: props.clusterName,
          ServiceName: props.serviceName,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      }),
      threshold: props.desiredCount,
      evaluationPeriods: 3,
      comparisonOperator:
        cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    liveTasks.addAlarmAction(notify);

    const structuredErrors = new cloudwatch.Alarm(this, 'StructuredErrorAlarm', {
      alarmName: `${ALARM_NAME_PREFIX}-StructuredErrors`,
      alarmDescription:
        'More than five structured error log events in ten minutes',
      metric: new cloudwatch.Metric({
        namespace: 'UniBudget/Application',
        metricName: 'StructuredErrorCount',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    structuredErrors.addAlarmAction(notify);
  }
}
