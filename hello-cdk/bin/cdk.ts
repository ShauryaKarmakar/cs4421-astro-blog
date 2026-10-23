#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
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
const certificateArnContext = app.node.tryGetContext('certificateArn');
const applicationUrlContext = app.node.tryGetContext('applicationUrl');
const supabaseHostContext = app.node.tryGetContext('supabaseHost');
const supabasePortContext = app.node.tryGetContext('supabasePort');
const supabaseDatabaseContext = app.node.tryGetContext('supabaseDatabase');

new UniBudgetStack(app, 'UniBudgetStack', {
  env: account && region ? { account, region } : undefined,
  desiredCount:
    desiredCountContext === undefined ? 0 : Number(desiredCountContext),
  imageTag:
    imageTagContext === undefined ? undefined : String(imageTagContext),
  certificateArn:
    certificateArnContext === undefined
      ? undefined
      : String(certificateArnContext),
  applicationUrl:
    applicationUrlContext === undefined
      ? undefined
      : String(applicationUrlContext),
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
