# Monitoring deployment plan — awaiting approval

Date: 2026-10-25
Branch: `chore/monitoring-alarm-identity` (based on `origin/main` at `4ce73f9`)
Stack affected: `UniBudgetStack` only
Status: **prepared, not deployed**. No AWS write was performed while preparing
this plan.

## 1. Verified production state

Read-only checks on 2026-10-25:

| Item | Observed |
| --- | --- |
| Alarms in the account | **0** (`describe-alarms` → `[]`) |
| Metric filters on `/unibudget/ecs/application` | **0** |
| Log group | `/unibudget/ecs/application`, retention 7 days, active streams |
| SNS topic | `arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms` |
| SNS subscription | email `karmakarshaurya@gmail.com`, **confirmed** (real subscription ARN) |
| Topic policy | `cloudwatch.amazonaws.com`, `sns:Publish`, this topic, `ArnLike aws:SourceArn = arn:aws:cloudwatch:us-east-1:556890483680:alarm:UniBudgetStack-*` |
| Live ECR lifecycle | tagged `*`/10 + untagged/10 (set out of band) |
| Stack template ECR lifecycle | tagged `any`/5 (stale) |
| ECS service | `ACTIVE`, desired 1 / running 1, `COMPLETED`, image `v1` |
| Deploy role | `unibudget-github-deploy` with `AdministratorAccess` |

The notification channel exists and is confirmed, but **no alarm has ever been
deployed**, so CloudWatch-to-SNS delivery has never been exercised.

## 2. Two implementations exist

| | Path A — application stack (selected) | Path B — `UniBudgetStack-Monitoring` |
| --- | --- | --- |
| Code | `hello-cdk/lib/cdk-stack.ts` | `hello-cdk/lib/monitoring-stack.ts` (uncommitted, concurrent workstream) |
| Alarms | 4, defined once | 4, duplicated definition |
| 5xx / structured-error comparison | `GreaterThanThreshold` (> 5) | `GreaterThanOrEqualToThreshold` (>= 5) |
| Metric filter | On the log group resource | Imported log group, same pattern |
| ECR drift | Reconciled by the same update | **Not** reconciled |
| Deploy surface | Existing stack update | New stack, 5 extra context values |
| Duplicate risk | none | 8 alarms and a doubled metric if A is ever released |

Path B's diff adds 4 alarms and 1 metric filter to a new stack but leaves the
ECR template drift in place. Because `cdk-stack.ts` also defines the same four
alarms, the next application release would create a second set with the same
metrics, and both metric filters would publish `StructuredErrorCount` for the
same log events, doubling the metric. Two definitions also already disagree at
the boundary (5 vs greater than 5).

## 3. Decision

**Deploy Path A only.** It keeps one source of truth, reconciles the ECR drift
in the same change, needs no new stack, and produces a diff that touches no ECS
service, task definition, image, migration, IAM, or log-group resource.

`UniBudgetStack-Monitoring` must **not** be deployed while the alarms remain in
`cdk-stack.ts`. If that path is ever preferred, remove the four alarms and the
metric filter from `cdk-stack.ts` first, in a separate reviewed change.

## 4. Exact change set (Path A)

Synthesized with the live context (`imageTag=v1`, `desiredCount=1`,
`supabaseHost=aws-0-eu-west-1.pooler.supabase.com`, port 5432, database
`postgres`, prefix list `pl-3b927c52`, topic ARN above).

Template SHA-256:
`d8e9278a77374dcc48e3300e45fc1c887309d9dbf800eeb0962fdb08c3abc4c3`

| Alarm name (physical) | Metric | Statistic / period | Condition | Missing data | Action |
| --- | --- | --- | --- | --- | --- |
| `UniBudgetStack-Target5xx` | `AWS/ApplicationELB` `HTTPCode_Target_5XX_Count` (ALB + target group) | Sum / 5 min, 2 periods | > 5 | `notBreaching` | topic |
| `UniBudgetStack-UnhealthyTargets` | `AWS/ApplicationELB` `UnHealthyHostCount` (ALB + target group) | Maximum / 1 min, 2 periods | > 0 | `notBreaching` | topic |
| `UniBudgetStack-RunningTaskCount` | `AWS/ECS` `RunningTaskCount` (cluster + service) | Average / 1 min, 3 periods | < 1 | `breaching` | topic |
| `UniBudgetStack-StructuredErrors` | `UniBudget/Application` `StructuredErrorCount` | Sum / 5 min, 2 periods | > 5 | `notBreaching` | topic |

Also in the change set:

- one `AWS::Logs::MetricFilter` on `/unibudget/ecs/application` matching
  `{ $.level = "error" }`, publishing `UniBudget/Application/StructuredErrorCount`;
- the ECR repository lifecycle policy text updated from the stale `any`/5 to
  the approved tagged `*`/10 + untagged/10 (the live policy already has this
  value; the update only reconciles the stack template).

`cdk diff` summary (read-only, `--no-change-set`):

```
[+] AWS::CloudWatch::Alarm Target5xxAlarm
[+] AWS::CloudWatch::Alarm UnhealthyTargetsAlarm
[+] AWS::CloudWatch::Alarm RunningTaskCountAlarm
[+] AWS::CloudWatch::Alarm StructuredErrorAlarm
[+] AWS::Logs::MetricFilter ApplicationErrorMetricFilter
[~] AWS::ECR::Repository ApplicationRepository  (LifecyclePolicyText only)
```

No `AWS::ECS::*`, `AWS::ECR::Repository` replacement, image, secret, role, or
migration change. `DesiredCount` stays 1 and the image stays `v1`.

### Why alarm names are now explicit

The live SNS topic policy only authorises publishing for alarm ARNs under
`UniBudgetStack-*`. Without an explicit `alarmName`, the physical name is
generated by CloudFormation at deploy time and cannot be verified from the
template, so the policy condition could fail silently. This branch sets the
four stable names above and asserts the prefix in CDK tests. Added on
`chore/monitoring-alarm-identity`; it must be merged before the alarm
deployment and before the application release so the release does not change
alarm identity.

## 5. Preconditions

1. This branch reviewed and merged to `main` (or the deploy performed from this
   exact commit with the approval below).
2. The diff above regenerated immediately before deployment; stop if any
   resource other than the five additions and the ECR policy text appears.
3. Operator has `cloudformation:*` on `UniBudgetStack` and the CDK bootstrap
   assets; the current deploy role already has `AdministratorAccess`.
4. No deployment is in progress: ECS primary rollout `COMPLETED`, CloudFormation
   stack `UPDATE_COMPLETE`.
5. Approval recorded for the exact template hash and the resource list.

## 6. Deployment (not executed)

```bash
cd hello-cdk
UNIBUDGET_AWS_ACCOUNT=556890483680 \
UNIBUDGET_AWS_REGION=us-east-1 \
npx cdk deploy UniBudgetStack \
  -c imageTag=v1 \
  -c desiredCount=1 \
  -c supabaseHost=aws-0-eu-west-1.pooler.supabase.com \
  -c supabasePort=5432 \
  -c supabaseDatabase=postgres \
  -c cloudFrontOriginPrefixListId=pl-3b927c52 \
  -c alarmTopicArn=arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms
```

Review the change-set confirmation; do not use `--require-approval never` for
this production update. The deploy creates no SNS topic and starts no task.

## 7. Verification after an approved deployment

```bash
aws cloudwatch describe-alarms \
  --alarm-name-prefix UniBudgetStack- \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue,Actions:AlarmActions}' \
  --output json
```

Pass conditions:

- exactly four alarms, named `UniBudgetStack-Target5xx`,
  `UniBudgetStack-UnhealthyTargets`, `UniBudgetStack-RunningTaskCount`,
  `UniBudgetStack-StructuredErrors`;
- every `AlarmActions` equals the topic ARN;
- every alarm ARN matches the policy's `alarm:UniBudgetStack-*` condition;
- one metric filter present:

```bash
aws logs describe-metric-filters \
  --log-group-name /unibudget/ecs/application \
  --query 'metricFilters[].{Pattern:filterPattern,Metrics:metricTransformations}'
```

- ECR lifecycle policy and a lifecycle preview:

```bash
aws ecr get-lifecycle-policy --repository-name <repository>
aws ecr start-lifecycle-policy-preview --repository-name <repository>
aws ecr get-lifecycle-policy-preview --repository-name <repository> \
  --query 'previewResult.imageDetails[].{Tags:imageTags,Action:action}'
```

Delivery proof, in order:

1. `aws sns publish` to the topic proves the subscription only (the owner has
   already confirmed it).
2. A real alarm transition is required to prove the CloudWatch publish path.
   Do not trigger it by breaking production. Wait for a genuine event, or use
   an approved synthetic in a non-production account. Alarm history must show
   `Successfully executed action arn:aws:sns:…`.

## 8. Risks and rollback

- **Stack update on production.** The change set is limited to five additions
  and the ECR policy text, but CloudFormation still updates the live stack.
  Confirm the diff immediately before approving.
- **Alarm delivery is unproven** until a real transition. The topic policy and
  names now match; evaluation is CloudWatch's responsibility.
- **Quiet periods.** Three alarms use `notBreaching`; absence of target 5xx
  traffic will not alarm. `RunningTaskCount` treats missing data as breaching.
- **Do not roll the stack back to the previous template to silence an alarm.**
  The previous template carries the unsafe `any`/5 ECR rule and would restore
  it. Instead disable actions (`aws cloudwatch disable-alarm-actions --alarm-names …`)
  or delete the four alarms; both keep the ECR policy and log data intact.
- **No data loss.** Alarms and metric filters hold no application data;
  deleting them loses only alarm history.

## 9. Approval required

Approve: `UniBudgetStack` update adding the four named alarms and one metric
filter, and reconciling the ECR lifecycle policy text, against template
`d8e9278a…` with no other resource change. Until that approval is recorded,
nothing in this plan has been applied.
