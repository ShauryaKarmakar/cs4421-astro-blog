# UniBudget CDK stack

This app defines the ECS Fargate application, ALB, CloudFront distribution,
ECR repository, migration task, and the retained RDS resources. The application
image is built from the repository root Dockerfile and pushed to ECR; the stack
does not deploy a local `dist` directory.

A separate `UniBudgetStack-Monitoring` stack (`lib/monitoring-stack.ts`) owns
the four CloudWatch alarms and the `level=error` metric filter. It imports the
existing log group, target-group dimensions, and SNS topic, so a monitoring
deploy does not update ECS, ECR, or IAM. The app stack defines no alarms or
metric filter; its test asserts zero. Do not deploy it for monitoring.

CloudFront serves HTTPS on its AWS-generated `*.cloudfront.net` hostname with
the AWS-managed certificate, so no custom domain or ACM certificate is needed.
The ALB is an HTTP origin that accepts traffic only from the CloudFront
origin-facing prefix list.

Run CDK commands from this `hello-cdk` directory. A release uses a semantic
image tag (`vMAJOR.MINOR.PATCH`); the stack itself accepts any valid immutable
tag because it also supports bootstrap and maintenance deploys. The stack
requires a Supabase session-pooler hostname and the regional CloudFront
origin-facing prefix list ID:

```bash
prefix_list_id=$(aws ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text)

npx cdk synth --no-lookups \
  -c imageTag=v1.1.0 \
  -c supabaseHost=<project-pooler-host> \
  -c cloudFrontOriginPrefixListId="$prefix_list_id"

npx cdk deploy --require-approval never \
  -c imageTag=v1.1.0 \
  -c desiredCount=0 \
  -c supabaseHost=<project-pooler-host> \
  -c cloudFrontOriginPrefixListId="$prefix_list_id"
```

`desiredCount=0` is the bootstrap deploy: it creates the ECR repository, task
definitions, load balancer, and CloudFront distribution without starting the
application. The application stack no longer accepts an alarm topic; monitoring
is deployed separately and imports the existing topic itself.

The stack declares ten-tagged/ten-untagged ECR retention. The live repository
policy, the deployed CloudFormation template, and this definition are equal
(checked 2026-10-27), so there is no pending ECR drift; see
[../docs/ecr-lifecycle-reconciliation.md](../docs/ecr-lifecycle-reconciliation.md).
Follow the full sequence in
[../docs/deployment.md](../docs/deployment.md) and the release gate in
[../docs/release-readiness.md](../docs/release-readiness.md).

## Monitoring stack

The monitoring stack is intentionally not part of the normal application
deploy. It is deployed as `UniBudgetStack-Monitoring` (`UPDATE_COMPLETE` on
2026-10-26) with five `OK` alarms and two metric filters; the fifth,
`Request5xx`, is the deployment alarm the application stack passes to the ECS
service through `-c deploymentAlarmName`. It uses
`LiveTaskCount`, not `RunningTaskCount`, because the latter requires CloudWatch
Container Insights. Use a reviewed direct command with the live ALB,
target-group, ECS, and topic values; see [../docs/alarms.md](../docs/alarms.md)
for the exact change-set history and rollback notes:

```bash
UNIBUDGET_AWS_ACCOUNT=<account> \
UNIBUDGET_AWS_REGION=<region> \
MSYS_NO_PATHCONV=1 \
npx cdk deploy UniBudgetStack-Monitoring --require-approval never \
  -c monitoringOnly=true \
  -c alarmTopicArn=<existing-sns-topic-arn> \
  -c loadBalancerFullName=app/<alb-name>/<alb-id> \
  -c targetGroupFullName=targetgroup/<tg-name>/<tg-id> \
  -c clusterName=<ecs-cluster-name> \
  -c serviceName=<ecs-service-name> \
  -c desiredCount=1 \
  -c logGroupName=/unibudget/ecs/application
```

The change set must contain only the five alarms, two metric filters, and
`CDKMetadata`. Stop if it proposes any ECS, ECR, IAM, SNS, or log-group change.

## Useful commands

- `npm run build` - type-check the project
- `npm run watch` - watch for changes and type-check
- `npm run test` - run the Jest unit tests
- `npx cdk diff` - compare the deployed stack with the current state (pass the same `-c` values)
- `npx cdk synth` - emit the synthesized CloudFormation template (pass the same `-c` values)
