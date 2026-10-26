# Monitoring deployment record and ownership

Date: 2026-10-25
Status: **Deployed — `UniBudgetStack-Monitoring` owns the alarms and metric
filter.** The earlier "Path A" proposal (inline alarms in `UniBudgetStack`) is
closed.

## 1. Decision

`hello-cdk/lib/monitoring-stack.ts` is the single canonical implementation of
the four production alarms and the application error metric filter. The
application stack (`hello-cdk/lib/cdk-stack.ts`) must not define either. This
file records the verified deployed state, the repository change that matches the
repository to it, and the checks that must hold before any further deployment.

## 2. Verified production state

Read-only queries on 2026-10-25 at ~17:55 UTC. Nothing in this section was
changed by this review.

| Fact | Verified value |
| --- | --- |
| Stack | `UniBudgetStack-Monitoring`, `UPDATE_COMPLETE`, last updated 2026-10-25 17:39:20 UTC |
| Resources | 6: four `AWS::CloudWatch::Alarm`, one `AWS::Logs::MetricFilter`, one `AWS::CDK::Metadata` |
| Resources not created | no ECS service, task definition, ECR repository, IAM role or policy, log group, or SNS topic |
| SNS topic | existing `arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms`, imported |
| Topic policy | `cloudwatch.amazonaws.com` may `sns:Publish` only when `aws:SourceArn` is `arn:aws:cloudwatch:us-east-1:556890483680:alarm:UniBudgetStack-*` |
| Alarm actions | all four alarms list the topic above as their only action |
| Application stack | `UniBudgetStack`, `UPDATE_COMPLETE`, last updated 2026-10-24 22:59:56 UTC; 51 resources; **0 alarms, 0 metric filters** |
| Application runtime | task definition `UniBudgetStackApplicationTask3DB06674:3`, image tag `v1`, desired 1 / running 1 |

Deployed alarms (from the live stack template):

| Alarm name | Metric | Statistic / period | Threshold | Missing data |
| --- | --- | --- | --- | --- |
| `UniBudgetStack-Monitoring-Target5xx` | `AWS/ApplicationELB` `HTTPCode_Target_5XX_Count` (ALB + target group) | Sum / 300 s, 2 periods | `GreaterThanThreshold` 5 | `notBreaching` |
| `UniBudgetStack-Monitoring-UnhealthyTargets` | `AWS/ApplicationELB` `UnHealthyHostCount` (ALB + target group) | Maximum / 60 s, 2 periods | `GreaterThanThreshold` 0 | `notBreaching` |
| `UniBudgetStack-Monitoring-LiveTaskCount` | `AWS/ECS` `LiveTaskCount` (cluster + service) | Average / 60 s, 3 periods | `LessThanThreshold` 1 | `breaching` |
| `UniBudgetStack-Monitoring-StructuredErrors` | `UniBudget/Application` `StructuredErrorCount` | Sum / 300 s, 2 periods | `GreaterThanThreshold` 5 | `notBreaching` |

Metric filter (from the live stack template): log group
`/unibudget/ecs/application`, pattern `{ $.level = "error" }`, metric
`UniBudget/Application` / `StructuredErrorCount`, value `1`, default `0`.

**Assumptions, not independently verified here:** the deployer recorded that the
stack was created with change sets `unibudget-monitoring-20261025-2` and
corrected by `unibudget-monitoring-20261025-3`, that the topic's email
subscription is confirmed, and that a manual `StructuredErrors` state transition
executed the SNS action. The subscription and an executed action are consistent
with the deployed actions, but no inbox receipt was inspected during this
review.

## 3. Why this stack, and why `LiveTaskCount`

- The generated application change set also proposed ECS service, task
  definition, ECR, and IAM changes caused by the repository reference. Alarm
  changes should not require touching the runtime.
- A second implementation existed at the same time. If the application stack had
  been updated with its own four alarms and filter, production would have had
  **eight alarms** and **two filters** publishing `StructuredErrorCount` for the
  same log events, halving the effective error threshold.
- `RunningTaskCount` requires CloudWatch Container Insights, which this service
  does not enable, so it had no datapoints. `LiveTaskCount` is published for a
  standard ECS service and is the reliable availability signal.
- All alarm names stay under the `UniBudgetStack-` prefix required by the
  existing topic policy. No SNS or IAM change was needed.

## 4. Repository change prepared (uncommitted)

- `hello-cdk/lib/cdk-stack.ts`: removed the four inline alarms, the metric
  filter, the SNS action wiring, the `alarmTopicArn` property, and the
  now-unused `cloudwatch`, `cloudwatch-actions`, and `sns` imports (124 lines
  removed). A comment records the ownership boundary.
- `hello-cdk/lib/monitoring-stack.ts`: added as the canonical implementation;
  imports the log group, topic, and dimension values, and creates no ECS, ECR,
  IAM, log-group, or SNS resource.
- `hello-cdk/bin/cdk.ts`: `-c monitoringOnly=true` synthesizes only the
  monitoring stack from its five required context values plus `desiredCount`;
  the application branch no longer accepts `alarmTopicArn`.
- `hello-cdk/test/unibudget-stack.test.ts`: asserts the application stack
  creates zero alarms and zero metric filters.
- `hello-cdk/test/monitoring-stack.test.ts`: asserts exactly four alarms and one
  filter, their names, metrics, dimensions, thresholds, missing-data behavior,
  SNS action, and that no owned resources are created.
- `docs/adr/0009-cloudwatch-observability.md`: logging schema preserved; alarm
  ownership, names, `LiveTaskCount`, and the reasons for the split updated.

## 5. Validation performed

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0, no diagnostics |
| `npx jest` (both CDK suites) | 2 suites, 27 tests passed, 0 failed |
| Synthesized application template | 51 resources, **0** `AWS::CloudWatch::Alarm`, **0** `AWS::Logs::MetricFilter`, 0 `AWS::SNS::Topic` |
| Synthesized monitoring template | 6 resources: four alarms, one filter, one `CDKMetadata`; no ECS, ECR, IAM, log group, or SNS resource |
| Cross-stack uniqueness | four alarm names, four unique values, all in the monitoring stack only |
| Live-template comparison | synthesized monitoring resources equal the live template with **0** property differences (excluding `CDKMetadata`) |
| Cross-stack dependencies | 0 `Fn::ImportValue` references in the monitoring template |
| `git diff --check` | exit 0, no whitespace errors |

Both templates were synthesized from the real `bin/cdk.ts` entry point: the
application stack with its normal context, and the monitoring stack with
`-c monitoringOnly=true` and its five context values plus `desiredCount`.

## 6. Operational leftovers and risks

- **`unibudget-monitoring-20261025-1` was never executed, and no longer
exists.** This change set on `UniBudgetStack` was created 2026-10-25 16:02:21
  UTC with 12 changes, including the four alarms and the metric filter that now
  belong to the monitoring stack; executing it would have recreated the
  duplicate alarms and doubled metric. A read-only check on 2026-10-26 lists no
  change sets for `UniBudgetStack`, `UniBudgetStack-Monitoring`, or
  `StaticSiteStack`, so the caution is historical.
- The deploy workflow previously passed `-c alarmTopicArn` to the application
  stack. Those two lines and the now-unused `ALARM_TOPIC_ARN` job variable were
  removed; the workflow no longer references the context at all. The monitoring
  stack is still deployed separately with its own context values.
- The application stack's ECR template still says `any` / keep 5 untagged,
  while the live repository policy retains 10. The next application deployment
  reconciles that drift; it is unrelated to monitoring ownership.
- The monitoring stack is not part of the application deploy workflow. Changing
  alarms requires its own explicit `monitoringOnly` synthesis and approval.
- The structured-error threshold counts only `level: "error"` records. A 5xx
  without an exception is covered by the target-5xx alarm, not this one.

## 7. Next approval

1. Review the uncommitted diff for the files above.
2. Commit and merge it before any application release, so the release uses the
   application stack that no longer defines alarms or the metric filter.
3. Then request separate approval for the release (tag, image, migration) and,
   independently, for deleting the stale application change set.
