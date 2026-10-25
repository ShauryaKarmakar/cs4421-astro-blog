# CloudWatch alarms and operator response

`hello-cdk/lib/monitoring-stack.ts` defines the separate monitoring stack with
four alarms and one metric filter. The alarms are only *deployed* when that
stack is executed; they are only *notifying* when it imports an existing SNS
topic with a confirmed subscription. The physical alarm names are explicit and
start with `UniBudgetStack-Monitoring-`, so they match the topic policy's
existing `UniBudgetStack-*` source condition.

`hello-cdk/lib/cdk-stack.ts` no longer defines any alarm or metric filter. The
application-stack test asserts zero `AWS::CloudWatch::Alarm` and
`AWS::Logs::MetricFilter` resources, so a future application release cannot
recreate the duplicate alarms or the second filter.

For drill-day triage — what to record first, which signal detects which
failure, and what is safe to do about it — use
[the chaos drill response playbook](chaos-drill.md). Log fields and
copy-pasteable Logs Insights queries are in [logging.md](logging.md).

## Deployment status at the time of this review

| Item | Code | Deployed | Notifying |
| --- | --- | --- | --- |
| Four alarms | Yes (`UniBudgetStack-Monitoring`) | **Yes** — final stack `UPDATE_COMPLETE` on 2026-10-25 17:39 UTC; four alarms present | CloudWatch executed the SNS action successfully; inbox receipt not independently verified |
| `level=error` metric filter | Yes, in the monitoring stack | **Yes** — one filter on `/unibudget/ecs/application` | n/a |
| SNS topic + subscription | Created; policy applied | **Yes** — topic exists | **Confirmed** — one email subscription has a real ARN |

The stack deliberately imports a topic ARN instead of creating a topic. This
keeps one notification destination across stacks and avoids subscribing an
unknown recipient from infrastructure code. Without a topic, alarm state
changes still appear in the console and `describe-alarms`, but no email or chat
message is delivered.

PR #40 was merged on 2026-10-25, but merging code does not deploy the stack.
The monitoring deployment happened later, as a separate approved operation. At
the start of this review the account had zero alarms and zero SNS topics; the
SNS topic and policy were then created and the email subscription requested.

The notification topic is
`arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms`. The topic and
its reviewed policy were created on 2026-10-25. One email subscription for the
operator address is now confirmed and has a real subscription ARN. The
recipient is not committed to the repository.

The separate stack `UniBudgetStack-Monitoring` is deployed (`UPDATE_COMPLETE`,
2026-10-25 17:39 UTC; created 17:33 UTC). It contains exactly four alarms, one metric filter, and
`CDKMetadata`; it did not modify the application stack, ECS, ECR, IAM, the log
group, or the SNS topic. The application stack remained `UPDATE_COMPLETE` with
its previous `LastUpdatedTime` (2026-10-24 22:59:56 UTC), and ECS stayed at
desired 1 / running 1.

CloudWatch-to-SNS delivery was tested without generating a production error by
manually setting `UniBudgetStack-Monitoring-StructuredErrors` to `ALARM` and
back to `OK`. Alarm history at 2026-10-25 17:34:53 UTC records
"Successfully executed action
arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms". That proves
CloudWatch executed the SNS action; it does not independently prove inbox
receipt, and it does not prove metric-threshold evaluation.

### Verified at drill preparation (2026-10-25)

| Item | Observed value |
| --- | --- |
| Running release | task definition `UniBudgetStackApplicationTask3DB06674:4`, image tag `v1.1.3`, digest `sha256:168b26…` |
| Log group | `/unibudget/ecs/application` exists, 7-day retention |
| Metric filter | on that log group, pattern `{ $.level = "error" }`, metric `UniBudget/Application` `StructuredErrorCount` |
| Filter vs emitted logs | matched: live log stream contains `{"level":"info","event":"http.request",…,"requestId":…}` records, so `level` is a top-level JSON field |
| Alarms | exactly four `UniBudgetStack-Monitoring-*`, all `OK`, each with `unibudget-production-alarms` as its action |
| Subscription | one email subscription with a real `SubscriptionArn` (confirmed) |
| Notification delivery | CloudWatch executed the SNS action for a manual `StructuredErrors` transition on 2026-10-25 17:34 UTC; inbox receipt still unverified |

No alarm threshold has been crossed by real traffic, and no production failure
was generated for this review.

## Alarm definitions

| Alarm | Metric and dimensions | Threshold | Periods | Missing data |
| --- | --- | --- | --- | --- |
| `Target5xxAlarm` | `AWS/ApplicationELB` `HTTPCode_Target_5XX_Count`, `LoadBalancer` = ALB, `TargetGroup` = target group | Sum > 5 | 2 x 5 min | `notBreaching` |
| `UnhealthyTargetsAlarm` | `AWS/ApplicationELB` `UnHealthyHostCount`, same dimensions | Maximum > 0 | 2 x 1 min | `notBreaching` |
| `LiveTaskCountAlarm` | `AWS/ECS` `LiveTaskCount`, `ClusterName` and `ServiceName` | Average < `desiredCount` | 3 x 1 min | `breaching` |
| `StructuredErrorAlarm` | `UniBudget/Application` `StructuredErrorCount` from the metric filter | Sum > 5 | 2 x 5 min | `notBreaching` |

The monitoring stack always creates `LiveTaskCountAlarm`; it requires a
positive `desiredCount` and uses that value as the threshold. This is the
monitoring path for the live service, which runs at desired count 1.
`LiveTaskCount` is an ECS service-utilization metric and does not require
CloudWatch Container Insights. The task-count alarm's missing-data behavior is
deliberately `breaching`, unlike the other alarms: no datapoint for
a service that should have tasks is itself suspicious.

`Missing data` is `notBreaching` for the other three alarms, so a new stack or
a quiet period without traffic does not page the operator. The trade-off: if
CloudWatch stops receiving those metrics, absence alone will not alert.

The metric filter matches JSON log events whose top-level `level` field is
exactly `"error"`. The synthesized filter pattern is
`{ $.level = "error" }`:

```json
{"level":"error","timestamp":"2026-10-25T16:02:36.418Z","event":"health.database.failed",
 "errorName":"Error","code":"42P01","requestId":"3f0c…","method":"GET","path":"/api/health"}
```

`src/lib/serverLogger.ts` writes only those fields. It never writes the error
message, stack trace, query text, user ID, email, or connection string. The
filter therefore has no access to user data or credentials.

Every request also writes one access record (`event: "http.request"`) with
`requestId`, `method`, `path`, `status`, and `durationMs`. A 4xx or 5xx response
is `level: "warn"`, not `error`, so a single failed request increments
`StructuredErrorCount` once (its exception record) rather than twice. The
access record and the exception record share a `requestId`, which is also
returned in the `X-Request-Id` response header; that is the join key described
in [logging.md](logging.md).

## Notification topic and subscription

The topic is intentionally not created by the stack. The topic, policy, and
confirmed email subscription exist. Do not commit the operator address to the
repository.

```bash
topic_arn="arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms"
aws sns create-topic --name unibudget-production-alarms --region us-east-1
aws sns set-topic-attributes \
  --topic-arn "$topic_arn" \
  --attribute-name Policy \
  --attribute-value "$(cat /tmp/unibudget-sns-topic-policy.json)" \
  --region us-east-1
aws sns subscribe \
  --topic-arn "$topic_arn" \
  --protocol email \
  --notification-endpoint <on-call-address> \
  --region us-east-1
aws sns list-subscriptions-by-topic \
  --topic-arn "$topic_arn" \
  --region us-east-1
```

The subscription shows a real `SubscriptionArn` rather than
`PendingConfirmation`. The deployed monitoring stack uses this topic directly;
the application stack no longer accepts `alarmTopicArn`, and the deploy workflow
no longer passes that context. Do not deploy the application stack to add
monitoring.

### Applied topic policy for CloudWatch

An SNS topic does not automatically allow CloudWatch to publish. The applied
policy grants only the CloudWatch service principal, only `sns:Publish`, only
on this topic, and only for alarms whose ARN begins with the
`UniBudgetStack-` prefix in this account and region:

```json
{
  "Version": "2012-10-17",
  "Id": "UniBudgetAlarmNotifications",
  "Statement": [
    {
      "Sid": "AllowUniBudgetCloudWatchAlarmsToPublish",
      "Effect": "Allow",
      "Principal": { "Service": "cloudwatch.amazonaws.com" },
      "Action": "sns:Publish",
      "Resource": "arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms",
      "Condition": {
        "ArnLike": {
          "aws:SourceArn": "arn:aws:cloudwatch:us-east-1:556890483680:alarm:UniBudgetStack-*"
        }
      }
    }
  ]
}
```

The JSON was validated locally and the live topic policy was read back with the
same principal, action, resource, and source-ARN condition. The four deployed
physical alarm ARNs all begin with
`arn:aws:cloudwatch:us-east-1:556890483680:alarm:UniBudgetStack-Monitoring-`,
so they match the `UniBudgetStack-*` condition. If the stack is renamed, update
the condition before relying on notification delivery.

If the topic uses server-side encryption, use a customer-managed KMS key whose
policy allows `cloudwatch.amazonaws.com` to call `kms:Decrypt` and
`kms:GenerateDataKey*`. The AWS-managed `alias/aws/sns` key cannot be edited to
add that permission. See the AWS re:Post knowledge-center article
[Resolve issues with SNS notifications from CloudWatch alarm triggers](https://repost.aws/knowledge-center/cloudwatch-receive-sns-for-alarm-trigger).

### Monitoring-only deployment path

Do **not** use `.github/workflows/deploy.yml` for this change. That workflow
builds and pushes an image, verifies a release tag, runs the migration task, and
deploys the application. None of that is part of adding alarms.

The approved approach is a separate stack, not an update to `UniBudgetStack`.
The stack imports the existing log group, target-group dimensions, and SNS
topic. Its physical alarm names are explicitly under
`UniBudgetStack-Monitoring-*`, which the live topic policy already permits
through its `UniBudgetStack-*` source condition.

Use a reviewed command like this, with the exact live values:

```bash
cd hello-cdk
UNIBUDGET_AWS_ACCOUNT=556890483680 \
UNIBUDGET_AWS_REGION=us-east-1 \
MSYS_NO_PATHCONV=1 \
./node_modules/.bin/cdk deploy UniBudgetStack-Monitoring \
  --require-approval never \
  -c monitoringOnly=true \
  -c alarmTopicArn=arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms \
  -c loadBalancerFullName=app/UniBud-Appli-p0ktuGjGHELm/af860c4c877d7051 \
  -c targetGroupFullName=targetgroup/UniBud-Appli-S7VNWXHA2XLE/b3a50584777d8e95 \
  -c clusterName=UniBudgetStack-ApplicationClusterC783CD56-hXQUSkONBCXV \
  -c serviceName=UniBudgetStack-ApplicationService423C69C6-YCFTDtV8bRhX \
  -c desiredCount=1 \
  -c logGroupName=/unibudget/ecs/application
```

Do not pass `imageTag`, Supabase settings, or `cloudFrontOriginPrefixListId` to
the monitoring-only app; those belong to the application stack. The
`MSYS_NO_PATHCONV=1` prefix is needed in Git Bash so the leading slash of the
log group name is not rewritten into a Windows path.

### Executed change sets

Change set `unibudget-monitoring-20261025-2` created the stack with the metric
filter, four alarms, and `CDKMetadata`. It was executed after approval. The
initial task-count alarm used `RunningTaskCount`, which requires CloudWatch
Container Insights and had no datapoints for this service; it transitioned to
`ALARM` at 17:35 UTC and executed the SNS action. That was a false alarm, not
an application outage (ECS was desired 1 / running 1).

Change set `unibudget-monitoring-20261025-3` replaced that single alarm with
`LiveTaskCountAlarm`, which uses the ECS service-utilization metric that is
available without Container Insights. The final stack is `UPDATE_COMPLETE`:

| Resource | Type | Status |
| --- | --- | --- |
| `ApplicationErrorMetricFilter66FE1147` | `AWS::Logs::MetricFilter` | `CREATE_COMPLETE` |
| `Target5xxAlarmB9F2DA7F` | `AWS::CloudWatch::Alarm` | `CREATE_COMPLETE` |
| `UnhealthyTargetsAlarm3F77BCD9` | `AWS::CloudWatch::Alarm` | `CREATE_COMPLETE` |
| `LiveTaskCountAlarm4FD29C08` | `AWS::CloudWatch::Alarm` | `CREATE_COMPLETE` |
| `StructuredErrorAlarm81F7FE35` | `AWS::CloudWatch::Alarm` | `CREATE_COMPLETE` |
| `CDKMetadata` | `AWS::CDK::Metadata` | `CREATE_COMPLETE` |

There was no `AWS::ECS::Service`, `AWS::ECS::TaskDefinition`,
`AWS::ECR::Repository`, `AWS::IAM::Policy`, `AWS::SNS::Topic`, or
`AWS::Logs::LogGroup` change in either change set. The physical alarm names are
`UniBudgetStack-Monitoring-Target5xx`,
`UniBudgetStack-Monitoring-UnhealthyTargets`,
`UniBudgetStack-Monitoring-LiveTaskCount`, and
`UniBudgetStack-Monitoring-StructuredErrors`.

### Why the old application-stack change set remains blocked

The earlier no-execute change set `unibudget-monitoring-20261025-1` on
`UniBudgetStack` is still `AVAILABLE` and still must not be executed. It exposed
additional modifications that the diff did not show:

- `ApplicationService423C69C6` — dynamic `TaskDefinition` reference;
- `ApplicationTaskE9624EFC` and `MigrationTask69EAEF9D` — `ContainerDefinitions`
  with `RequiresRecreation: Always`, caused by `ApplicationRepository13E54097.Arn`;
- both task execution-role default policies — dynamic `PolicyDocument`
  references to the same repository ARN.

These are CloudFormation dynamic-reference effects of the ECR resource update.
Executing that change set could register new task-definition revisions and start
an ECS deployment even though the image tag remains `v1`. It remains blocked
pending a safe ECR/application-stack reconciliation. Do not delete it while the
investigation is open; it is the evidence for the discrepancy.

The application stack no longer defines alarm or metric-filter resources. The
old change set remains dangerous only if executed: it would recreate the four
alarms and the filter that are now owned by the monitoring stack. Do not execute
it; removal of the stale change set needs separate approval.

### Required permissions

| Operation | Minimum actions | Scope |
| --- | --- | --- |
| Create topic | `sns:CreateTopic` | `arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms` |
| Set policy | `sns:SetTopicAttributes`, `sns:GetTopicAttributes` | same topic |
| Subscribe | `sns:Subscribe`, `sns:ListSubscriptionsByTopic` | same topic |
| Test channel | `sns:Publish` | same topic |
| CDK create | `cloudformation:CreateChangeSet`, `DescribeChangeSet`, `ExecuteChangeSet`, `DeleteChangeSet`, `DescribeStacks`, `DescribeStackEvents`, `GetTemplate` | `UniBudgetStack-Monitoring` |
| Alarms | `cloudwatch:PutMetricAlarm`, `cloudwatch:DescribeAlarms` | `UniBudgetStack-Monitoring-*` |
| Metric filter | `logs:PutMetricFilter`, `logs:DescribeMetricFilters` | `/unibudget/ecs/application` |
| CDK bootstrap | `s3:GetObject`, `s3:PutObject`, `ssm:GetParameter` | CDK bootstrap asset bucket and version parameter |

The monitoring-only path does **not** require `ecr:PutLifecyclePolicy`,
`ecs:UpdateService`, or `iam:*`. The earlier `UniBudgetStack` change set would
have required those actions and remains blocked.

The deployment role currently has `AdministratorAccess`, so these actions are
available without an IAM change. This table is the functional minimum for this
monitoring update, not an IAM policy proposal; the broader least-privilege
migration remains a separate release blocker.

### Verification after deployment

```bash
aws cloudwatch describe-alarms \
  --alarm-name-prefix UniBudgetStack-Monitoring- \
  --query 'MetricAlarms[].{Name:AlarmName,Actions:AlarmActions,State:StateValue}' \
  --output json
```

Observed on 2026-10-25 after change set `-3`: four alarms, each with the topic
ARN in `AlarmActions`; `Target5xx`, `UnhealthyTargets`, `LiveTaskCount`, and
`StructuredErrors` were all `OK`. No alarm was duplicated. A direct publish to
the topic proves the channel and subscription only:

```bash
aws sns publish --topic-arn arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms \
  --message "UniBudget alarm channel test" --region us-east-1
```

It does **not** prove that CloudWatch is allowed to publish or that alarm
evaluation works. Alarm evaluation is proven only by a real metric crossing a
threshold, and the alarm history must show
`Successfully executed action arn:aws:sns:...`. Do not generate a production
error or break a route to test this.

## Triage

### `Target5xxAlarm`

Likely causes: an application exception, a failed dependency, a bad deploy, or
a route that returns 500 (for example a broken SSR blog route in an old image).
First steps:

1. Open the target group's unhealthy/5xx graph and correlate with deploy time.
2. Query the application log group for `level = "error"` in the same window.
3. Check whether the current task definition's image digest is the intended
   release.
4. Roll back to the previous task definition revision if the error started
   with the deploy and readiness is failing.

### `UnhealthyTargetsAlarm`

Likely causes: readiness failing because PostgreSQL is unreachable, a task
crash-loop, or a security-group/prefix-list change. This alarm can fire during
a database outage even though the process is alive, because readiness depends
on the database. First steps:

1. Call `/api/live` and `/api/health` from inside the VPC or via a temporary
   ECS exec session. Liveness should stay 200 during a database outage.
2. Check the ECS service events for task replacement and the circuit breaker.
3. Confirm the database is reachable from the task's security group. Do not
   restart tasks to "fix" a database outage; readiness will recover when the
   dependency returns.

### `LiveTaskCountAlarm`

Likely causes: tasks cannot start (image pull failure, missing secret,
insufficient CPU), a task crashed and is being replaced, or a deployment is in
progress. Because missing data is `breaching`, a service that emits no
`LiveTaskCount` datapoints also alarms. First steps:

1. `aws ecs describe-services` for `runningCount`, `desiredCount`, and events.
2. Check stopped-task reasons for image, secret, or health-check failures.
3. The monitoring stack always creates this alarm with a positive desired
   count. A direct service scale to zero will therefore trip it; do not use a
   manual scale to zero as an operating state.

### `StructuredErrorAlarm`

Likely causes: database query failures, migration/schema mismatch, or an
application bug. This alarm counts structured errors, not all log volume. First
steps:

1. CloudWatch Logs Insights on `/unibudget/ecs/application`:
   `fields @timestamp, level, event, errorName, code, requestId, method, path | filter level = "error" | sort @timestamp desc | limit 50`.
   Take one `requestId` and read its access record to see which route returned
   which status and how long it took.
2. Map frequent `event` values to code paths.
3. A `code` beginning with `42` is a PostgreSQL schema/permission error; check
   whether the migration ran before the deploy.

## What is still unverified

- CloudWatch **executed** the SNS action for a manual `StructuredErrors` state
  change (`Successfully executed action arn:aws:sns:...`). Inbox receipt was not
  independently verified, and the manual transition was not a real metric
  threshold breach.
- No synthetic production error was generated. The parser is covered by unit
  tests locally; live metric increments require a real event. Do not break a
  route to test this metric.
- `Target5xx`, `UnhealthyTargets`, and `LiveTaskCount` were `OK` at the final
  read-back. `StructuredErrors` was restored to `OK` after the manual test.
  Their threshold-crossing behavior has not been observed end to end.
- The existing `Deploy` workflow is not a monitoring-only path: it builds and
  pushes an image, checks a release tag, and runs migrations. Use the reviewed
  separate-stack `cdk deploy` path above instead.
- The alarm names must stay under `UniBudgetStack-*` to match the live SNS
  topic policy. If the stack is renamed, update the policy before expecting
  delivery.
- `UniBudgetStack` contains no alarm or metric-filter resources; its test
  asserts that absence. The old application-stack change set would recreate
  duplicates if executed, so it must remain unexecuted until separately
  removed.
