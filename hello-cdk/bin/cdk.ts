#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { UniBudgetMonitoringStack } from '../lib/monitoring-stack';
import { UniBudgetStack } from '../lib/cdk-stack';

const app = new cdk.App();
const account = process.env.UNIBUDGET_AWS_ACCOUNT;
const region = process.env.UNIBUDGET_AWS_REGION;
if (Boolean(account) !== Boolean(region)) {
  throw new Error(
    'Set both UNIBUDGET_AWS_ACCOUNT and UNIBUDGET_AWS_REGION for deployment.',
  );
}

const desiredCountContext = app.node.tryGetContext('desiredCount');
const imageTagContext = app.node.tryGetContext('imageTag');
const cloudFrontOriginPrefixListIdContext = app.node.tryGetContext(
  'cloudFrontOriginPrefixListId',
);
const supabaseHostContext = app.node.tryGetContext('supabaseHost');
const supabasePortContext = app.node.tryGetContext('supabasePort');
const supabaseDatabaseContext = app.node.tryGetContext('supabaseDatabase');
const monitoringOnly = app.node.tryGetContext('monitoringOnly') === 'true';

const requiredContext = (name: string): string => {
  const value = app.node.tryGetContext(name);
  if (value === undefined || value === '') {
    throw new Error(`Missing required context value: ${name}`);
  }
  return String(value);
};

if (monitoringOnly) {
  const desiredCount = Number(requiredContext('desiredCount'));
  if (!Number.isInteger(desiredCount) || desiredCount < 1) {
    throw new Error('desiredCount must be a positive integer');
  }

  // Keep the stack under the existing `UniBudgetStack-*` SNS topic-policy
  // source prefix. This stack imports the log group, SNS topic and metric
  // dimensions; it does not update the application stack or ECS resources.
  new UniBudgetMonitoringStack(app, 'UniBudgetStack-Monitoring', {
    env: account && region ? { account, region } : undefined,
    alarmTopicArn: requiredContext('alarmTopicArn'),
    loadBalancerFullName: requiredContext('loadBalancerFullName'),
    targetGroupFullName: requiredContext('targetGroupFullName'),
    clusterName: requiredContext('clusterName'),
    serviceName: requiredContext('serviceName'),
    desiredCount,
    logGroupName: app.node.tryGetContext('logGroupName'),
  });
} else {
  new UniBudgetStack(app, 'UniBudgetStack', {
    env: account && region ? { account, region } : undefined,
    desiredCount:
      desiredCountContext === undefined ? 0 : Number(desiredCountContext),
    imageTag:
      imageTagContext === undefined ? undefined : String(imageTagContext),
    cloudFrontOriginPrefixListId:
      cloudFrontOriginPrefixListIdContext === undefined
        ? undefined
        : String(cloudFrontOriginPrefixListIdContext),
    supabaseHost:
      supabaseHostContext === undefined
        ? undefined
        : String(supabaseHostContext),
    supabasePort:
      supabasePortContext === undefined
        ? undefined
        : String(supabasePortContext),
    supabaseDatabase:
      supabaseDatabaseContext === undefined
        ? undefined
        : String(supabaseDatabaseContext),
  });
}
