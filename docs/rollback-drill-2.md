# Rollback Drill 2 — isolated runbook

Status: **executed twice on 2026-10-26** in drill account `293633790894`
(us-east-1), in two separate stack lifecycles.

- **Run 1** ([Recorded result](#7-recorded-result)): failure, detection, and
  restore are evidenced. Two acceptance criteria did not pass — no CloudWatch
  alarm transitioned, and the rollout did not roll back automatically, so
  recovery was an explicit `update-service`.
- **Run 2** ([Retest after the fixes](#8-retest-after-the-fixes)), after the
  monitoring and rollback changes: the alarm transitioned, ECS failed the
  deployment on the alarm and rolled back with no operator action, and the
  public endpoint stayed healthy throughout. Notification delivery was still
  **not** verified.

Neither run touched production. The changes from run 2 were deployed to
production afterwards, on 2026-10-26: `UniBudgetStack-Monitoring` gained the
filter and alarm, and `UniBudgetStack` attached `Request5xx` to the ECS service
as its deployment alarm. Production has **not** yet had a rollout stopped by
that alarm; only the drill account has.

The production account must not be used to create an intentional outage. The
stack uses fixed resource names (`UniBudgetStack`, `/unibudget/ecs/application`,
`unibudget/supabase/*`), so a second stack in the same account is not a valid
isolated environment.

## 0. What this drill must prove

1. A task that fails its liveness check is detected by ECS without an operator
   touching the service.
2. The deployment circuit breaker stops the failed rollout and restores the
   last `COMPLETED` task definition automatically.
3. The restored service serves the baseline image digest, not the drill image.
4. `/api/health`, `/login`, a real `/blog/<slug>` and an unknown slug return
   their expected statuses after recovery.
5. Recovery time and traffic errors during the window are recorded in UTC.

It must also show that the release workflow's post-deploy gate would reject a
rollback that silently left the old task set running: the gate requires the
primary deployment to be `COMPLETED` and the running task digest to match the
image this run published.

This drill is **not** a database recovery exercise, a blue/green switch, or a
validation of a production change. It runs only in the isolated account below.

## 1. Environment isolation

Use a separate AWS account with:

- its own CDK bootstrap (`CDKToolkit`) and deployment role;
- its own ECR repository and image;
- its own VPC, ALB, CloudFront distribution, ECS cluster/service, and log
  group;
- a disposable Supabase project/database containing no production data;
- no shared Secrets Manager secret or production credentials.

Record the drill account ID, region, stack name, and domain. Do not record
secret values.

## 1a. Account hand-off checklist

Creating the drill account is an owner action; nothing in this repository can
create it. Record these before scheduling the drill:

| Item | Value |
| --- | --- |
| Drill account ID | **Pending** — no separate account exists yet, and the deployment account is not in an AWS Organization |
| Region | `us-east-1` (proposed; matches production, change it before provisioning if the budget or latency target says otherwise) |
| Approved budget and drill window | **Not approved** — proposed ceiling is $80 and a two-day window |
| Operator identity | `ShauryaKarmakar` |
| Confirmation the drill role cannot reach production | **Pending** — test with `aws sts get-caller-identity` and a denied production call from the drill role before starting |

Minimum footprint: one small Fargate task, an ALB, a CloudFront distribution,
an ECR repository, a disposable database, and outbound networking. The ALB and
NAT gateway dominate the cost; expect roughly **$40–$80 for a two-day drill**
depending on region and networking choice. Confirm with the AWS pricing
calculator before approval and destroy the stack afterwards. This is an
estimate, not a quote.

Provisioning sequence:

1. Create the account and an IAM role the deploy workflow can assume, trusted
   only for the drill repository/environment.
2. Bootstrap CDK, then deploy the stack with `bootstrapOnly=true` or
   `desiredCount=0`.
3. Push the baseline image to the drill ECR repository and record its digest.
4. Record the baseline task definition, rollout state and route statuses
   before introducing the failing image.

Run the drill from a fork (or a separate repository `production` environment)
with drill-scoped `AWS_ACCOUNT_ID`, `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION` and
`SUPABASE_HOST` values. `deploy.yml` asserts that the assumed account equals
`AWS_ACCOUNT_ID` and verifies the running digest, so repointing this
repository's production variables at the drill account would disable the
production deploy gate. Never change them for a drill.
**Deviation used on 2026-10-26:** the drill database was the stack's own RDS
instance instead of a Supabase project. That instance is created by
`UniBudgetStack` specifically for the drill, holds no production data, and is
unreachable from outside the VPC. The `supabaseHost` and `supabaseDatabase`
context values were pointed at it (database `unibudget`), and the three
`unibudget/supabase/*` secrets held the RDS administrator credential, the
`unibudget_app` role credential, and the regional RDS CA bundle. The project's
migration runner created the role and schema inside the VPC. No production
database was contacted.

## 2. Prerequisites

1. Approve the drill account and its cost/time budget.
2. Bootstrap CDK and create the drill stack by hand with `cdk deploy
   -c desiredCount=0` (the release workflow only updates an existing stack).
3. Confirm the drill CloudFront URL, `/api/health`, `/login`, and a real
   `/blog/<slug>` return the expected status.
4. Record the baseline task definition ARN, image tag, **image digest**,
   desired count, and alarm states.
5. Confirm the drill database is disposable and has a restore point or can be
   recreated from migrations.

### Preparation status

| Prerequisite | Status | Evidence |
| --- | --- | --- |
| Separate AWS account approved | **Confirmed** | `293633790894`, us-east-1; approved for one short session |
| Drill CDK bootstrap and deploy role | **Confirmed** | `CDKToolkit` created, then destroyed at cleanup |
| Drill stack deployed with `desiredCount=0` | **Confirmed** | `CREATE_COMPLETE` in 9 m 33 s |
| Drill ECR repository and baseline image | **Confirmed** | `unibudgetstack-applicationrepository13e54097-juvj80yautoj`, tag `v1.1.3`, digest `sha256:949cfc…` |
| Disposable drill database | **Confirmed (deviation)** | Stack RDS `unibudgetstack-applicationdatabase…`, no production data; see §1 |
| Baseline route statuses recorded | **Partial** | `/api/health` 200; `/login` and the blog routes were not checked |
| Drill-only failing image | **Confirmed** | Tag `v0.0.0-drill.1`, digest `sha256:6bf3b0…`; pushed to the drill repository only |

Every row was satisfied for the 2026-10-26 run except the two marked Partial
and Deviation. The production account and the production database were never
substituted for any row.

## 3. Controlled failure

Build a drill-only image that fails its container health check, for example a
process that exits immediately or serves 503 from `/api/live`. Push it to the
drill ECR under a non-release tag such as `v0.0.0-drill.1`. Never push it to
the production repository.

**Actual failure used on 2026-10-26:** three lines in `src/pages/api/health.ts`
returned HTTP 500 after a successful database check. `/api/live` was
deliberately left working, so the container stayed alive and the failure
surfaced only through readiness, which is the probe the ALB gates on. The change
was made in a detached worktree at tag `v1.1.3`: never committed, never pushed
to Git, and never pushed to the production ECR.

## 4. Procedure and observations

| Step | Action | Evidence |
| --- | --- | --- |
| 1 | Record T0 and baseline service/task/image digest | `describe-services`, `describe-tasks`, UTC timestamp |
| 2 | Deploy the drill-only image through the drill stack | workflow/run URL or command |
| 3 | Observe the first failed liveness probe | ECS task stopped reason and timestamp |
| 4 | Observe target health and readiness | `describe-target-health`; `UnHealthyHostCount` |
| 5 | Observe deployment failure and circuit-breaker rollback | ECS deployment events; rollout state |
| 6 | Record rollback start and completion | UTC timestamps and deployment JSON |
| 7 | Verify restored task definition and digest | `describe-services`, `describe-tasks` |
| 8 | Verify `/api/health`, `/login`, `/blog/<slug>` | HTTP status and response body |
| 9 | Record recovery duration and any traffic errors | T0-to-healthy, 5xx count |

The expected behavior is: ECS liveness fails, tasks are replaced or the
deployment fails, the circuit breaker stops the failed rollout and restores the
last completed task definition, and the ALB returns healthy only after the
readiness endpoint succeeds.

### Observed on 2026-10-26 (UTC)

| Step | Observed |
| --- | --- |
| 1 | Baseline revision `UniBudgetStackApplicationTask3DB06674:2`, tag `v1.1.3`, digest `sha256:949cfc…`, desired 1 / running 1, rollout `COMPLETED`, target `healthy`, four alarms `OK` |
| 2 | `ecs update-service` to revision `:3` at **T0 19:11:37Z** |
| 3 | Broken task started **19:11:50Z**; first failed readiness probe **19:12:31Z**, 41 s later (`/api/health` 500, logged with a request id); `/api/live` stayed 200 throughout |
| 4 | Target `initial` 19:12:30Z, declared unhealthy **19:13:42Z** with `Health checks failed with these codes: [500]`; `UnHealthyHostCount` never rose above 0.0 |
| 5 | No circuit-breaker rollback. The deployment stayed `IN_PROGRESS` for about 14 minutes with `failedTasks: 2`; ECS stopped each failing task about one second after the first unhealthy report and launched a second attempt at 19:19:51Z |
| 6 | Explicit rollback issued **19:25:22Z**; deployment `COMPLETED` and steady state **19:30:04Z** |
| 7 | Restored revision `:2`, digest `sha256:949cfc…` (identical to the baseline) |
| 8 | `/api/health` returned 200 before, during, and after the drill through CloudFront; `/login` and the blog routes were not checked |
| 9 | T0 → detected 1 m 52 s; T0 → restored 18 m 27 s; no viewer-facing 5xx observed |

The expected behavior did **not** hold in two places. The alarm never fired
because ECS removes a failing target about one second after the first unhealthy
report, so a 2 × 1-minute alarm window is never satisfied. The circuit breaker
did not roll back either: with `minHealthyPercent: 100` and `desiredCount: 1`
the service kept the healthy task and retried the broken revision instead of
failing the deployment. Its effective threshold is **three** failed tasks (ECS
clamps the bounded-percent calculation to a minimum of 3), and only two
failures occurred in the 14 minutes before the operator intervened, so it was
working as documented but far too slowly to be the rollback path for this
service. Availability was protected throughout — the public endpoint returned
200 for the whole window — but recovery needed an operator, not automation.

## 5. Acceptance criteria

| Criterion | Required | Observed |
| --- | --- | --- |
| Detection latency | under 2 minutes from failed task start | **Pass** — 41 s from task start (19:11:50Z) to the first failed probe, 1 m 52 s to `unhealthy` |
| Rollback without manual task-definition change | yes | **Fail** — the circuit breaker did not roll back; an explicit `update-service` to revision `:2` was issued at 19:25:22Z |
| Restored digest equals baseline digest | yes | **Pass** — `sha256:949cfc…` |
| `/api/health` returns 200 after recovery | yes | **Pass** — 200 `{"status":"ok"}` |
| `/login` and the blog route return the expected status | yes | **Not checked** — not measured before cleanup |
| No sustained 5xx beyond the probe window | yes | **Pass (viewer side)** — 200 throughout; only the ALB probes received 500 |
| Evidence timestamps in UTC | yes | **Pass** — every recorded timestamp is UTC |

If any row is blank, the drill is not complete. Do not infer timings from
CloudWatch retention or reconstruct them later. The 2026-10-26 run has one
failed row and one unmeasured row, so it does not meet these criteria.

The rollback-detection logic is covered by workflow contract tests in
`tests/deployWorkflow.test.ts` (primary rollout must be `COMPLETED`, running
digest must match the published image). Those tests protect the gate from
silently disappearing; they are not evidence that a real rollback occurred.

## 6. Cleanup and cost

1. Scale the drill service to zero or destroy the drill stack after evidence is
   captured.
2. Delete drill-only ECR images according to the approved retention policy.
3. Remove the disposable database only after the evidence is exported.
4. Confirm the production account and production stack were never targeted.

### Cleanup performed on 2026-10-26

`UniBudgetStack`, `UniBudgetStack-Monitoring`, and `CDKToolkit` were destroyed.
Because the stack marks RDS, ECR, the log group, and the secrets
`RemovalPolicy.RETAIN`, and RDS had deletion protection enabled, the destroy
stalled on the database subnet until the RDS instance was deleted manually
(`--skip-final-snapshot --delete-automated-backups`). The RDS subnet group, both
ECR repositories, both log groups, the five secrets, the SNS topic, the S3
bootstrap bucket, and the hand-registered task-definition revision were then
removed. A final sweep showed no RDS, ECS, ECR, ALB, CloudFront, log group,
secret, SNS topic, S3 bucket, alarm, or NAT gateway. The pre-existing default
VPC was retained. Total spend stayed under US$1 because the stack was live for
about 45 minutes.

## 7. Recorded result

- Executed: **yes**, once
- Date/time: 2026-10-26, 18:57Z–19:52Z (UTC)
- Operator: repository owner
- Drill account: `293633790894`, region `us-east-1`, stack `UniBudgetStack`
- Baseline image: tag `v1.1.3`, digest
  `sha256:949cfcf830dc11b64439ebec87662336f4fefecf456ca7ebfd18d7cb6be99731`,
  revision `:2`
- Failure image: tag `v0.0.0-drill.1`, digest
  `sha256:6bf3b039bcaac7a9a850c968b2e126b438e73bc48a6ff3629f83dce3c1c8db63`,
  revision `:3`
- Failure mode: `/api/health` returned 500; `/api/live` unaffected
- T0: 2026-10-26T19:11:37Z
- T0 → detected: 2 m 5 s (ECS started the task 19:11:50Z; first failed probe
  19:12:31Z, `unhealthy` 19:13:42Z — 1 m 52 s after the task started)
- T0 → restored: 18 m 27 s (steady state 19:30:04Z)
- Rollback: **explicit** — `ecs update-service` to revision `:2` at 19:25:22Z
- Circuit breaker: **did not roll back**; the deployment stayed `IN_PROGRESS`
  with 2 failed tasks for about 14 minutes
- CloudWatch alarms: **no transition**; all four stayed `OK` and
  `UnHealthyHostCount` recorded 0.0 for every minute
- Restored digest equals baseline digest: **yes**
- Viewer impact: none observed; `/api/health` through CloudFront returned 200
  throughout
- Result: **partial** — failure, detection, and restore are evidenced;
  automatic rollback and alarm notification are not

Evidence was captured in a local, untracked `drill-evidence/` folder:
`git-evidence.txt`, `health-check-results.txt`, `ecs-deployment-events.txt`,
`cloudwatch-alarm-history.txt`, `image-verification.txt`, and
`cleanup-results.txt`.

Open gaps this run exposed:

1. `UnhealthyTargets` cannot fire while ECS replaces a failing target within
   seconds; its 2 × 1-minute window is never satisfied.
2. The deployment circuit breaker did not stop the rollout inside the drill
   window: with a single task its threshold is three failed tasks, so recovery
   depended on an operator.
3. The structured-error metric filter matches `level = "error"`, but 5xx access
   records are written at `level = "warn"`, so `StructuredErrors` cannot catch
   request failures either.

## 8. Retest after the fixes

Run 1 exposed three gaps. Two of them were corrected in the CDK code and then
re-run end to end in the same disposable account, with nothing reused from the
first run except the account and region.

### What changed

| Gap | Change | Where |
| --- | --- | --- |
| No alarm could see a failing readiness probe | New metric filter `Http5xxCount` matching the numeric `status >= 500` field of every request record (health probes included), and a new alarm `Request5xx` at `Sum > 0` over one 1-minute period | `hello-cdk/lib/monitoring-stack.ts` |
| No automatic rollback | The `Request5xx` alarm is attached to the ECS service as a **deployment alarm** with `ROLLBACK_ON_ALARM`; its name arrives through the `deploymentAlarmName` context instead of a cross-stack reference | `hello-cdk/lib/cdk-stack.ts`, `hello-cdk/bin/cdk.ts` |
| — | Stack tests and the observability contract were updated for the fifth alarm | `hello-cdk/test/*.test.ts`, `tests/observabilityContract.test.ts`, `docs/alarms.md` |
| A rollout could start without any deployment alarm | The CDK entry point now refuses `desiredCount > 0` without `deploymentAlarmName`, and the deploy workflow verifies the named alarm exists, measures `UniBudget/Application` `Http5xxCount`, has actions enabled, and passes it to the stack; the post-deploy check fails the release if the service is not watching it | `hello-cdk/lib/deployment-context.ts`, `hello-cdk/bin/cdk.ts`, `.github/workflows/deploy.yml` |

The deployment alarm is the mechanism this service relies on, not the circuit
breaker. ECS clamps the bounded-percent failed-task threshold to a **minimum of
three failed tasks** while the service runs `desiredCount: 1`, so the breaker
needs three failed launches before it acts. At run 1's cadence — one failed
launch roughly every eight minutes — that is a rollout of about 25 minutes,
which is why the breaker remains enabled for its restart behaviour but is not
the rollback path. The alarm failed the rollout after 33 seconds.

The last row was added **after** run 2 and is covered by local tests and
workflow checks only; it has not been exercised against AWS. It exists because
the workflow previously deployed the service with `Alarms.Enable=false` and
said nothing about it, which is exactly the silent-loss case this drill was
meant to remove.

### Observed on 2026-10-26 (second run, UTC)

| Time | Event |
| --- | --- |
| 20:28:29 | Baseline `v1.1.3` (revision `:5`) at steady state, all alarms `OK` |
| 20:32:47 | `T0` — broken revision `:6` deployed with `ecs update-service` |
| 20:33:07 | ECS started the broken task |
| 20:33:37 | First `500` from `/api/health` on the new task |
| 20:34:10 | `Request5xx` executed `OK → ALARM` (`T0 + 1 m 23 s`) |
| 20:34:14 | ECS: `deployment failed: alarm detected` |
| 20:34:14 | ECS: `rolling back to deployment ecs-svc/6246541257980501183` — no operator action |
| 20:34:46 | ALB finally reported the broken task `unhealthy` (`[500]`) — **32 s after ECS had already given up on the rollout** |
| 20:34:46 | Broken task stopped |
| 20:35:57 | Rollback `COMPLETED`, service at steady state (`T0 + 3 m 10 s`) |
| 20:36:10 | `Request5xx` executed `ALARM → OK` |

### Acceptance criteria, second run

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | A known-bad version is deployed deliberately | Pass | revision `:6`, digest `sha256:cc9aa9f1…`, never committed |
| 2 | The bad version fails its health check | Pass | 6 × `/api/health` `500` in the task log; `/api/live` `200` in the same window |
| 3 | Failure is detected automatically | Pass | `OK → ALARM` 33 s after the first failed probe |
| 4 | A CloudWatch alarm notifies an operator | **Partial** | Alarm transitioned (`OK → ALARM → OK`) and the stack attaches the SNS action, but no `Action` history item was captured and the drill account had no verified subscription; no notification is evidenced |
| 5 | The previous version is restored automatically | Pass | `deployment failed: alarm detected` → `rolling back` within 1 ms of each other |
| 6 | The restored image is byte-identical to the baseline | Pass | running digest `sha256:e43a4867…` equals the baseline digest |
| 7 | Users are unaffected during the rollout | Pass | public `/api/health` through CloudFront returned `200` for the whole window |
| 8 | The environment is destroyed after the drill | Pass | stack deletions and the final sweep in `drill-evidence-retest/cleanup-results.txt` |

### Comparison with run 1

| Measure | Run 1 (before fixes) | Run 2 (after fixes) |
| --- | --- | --- |
| Detection | 2 m 5 s from T0, by ALB target health (1 m 52 s after the task started) | 1 m 23 s from T0, by CloudWatch alarm |
| CloudWatch alarm transition | none — all four stayed `OK` | `OK → ALARM → OK` |
| Rollback | manual, `ecs update-service` | automatic, by ECS deployment alarm |
| T0 → healthy | 18 m 27 s | 3 m 10 s |
| Operator action after T0 | one rollback command | none |
| Result | partial | **pass**, except unverified inbox delivery |

Evidence for the second run is in the untracked `drill-evidence-retest/` folder:
`git-evidence.txt`, `health-check-results.txt`, `ecs-deployment-events.txt`,
`cloudwatch-alarm-history.txt`, and `cleanup-results.txt`.

### What is still open

1. **Production runs the new alarm and filter, but has not exercised them.**
   Both were deployed on 2026-10-26 in the fixed order: monitoring stack first
   (it owns `Request5xx` and imports the log group and target group), then a
   normal `UniBudgetStack` deployment. The live service reports
   `deploymentConfiguration.alarms = [UniBudgetStack-Monitoring-Request5xx]`
   with `rollback: true`; the alarm evaluates real traffic and is `OK`. No
   production rollout has failed since, so the only stopped rollout remains
   run 2 below. The workflow verifies the alarm before building or migrating
   and refuses to roll out without it; a manual `cdk deploy` with
   `desiredCount >= 1` is refused at synthesis for the same reason.
2. **Notification delivery.** Nothing in this run proves a notification was
   sent. Only `StateUpdate` history was captured, no `Action` item exists in the
   evidence, and no subscription was confirmed in the drill account. Delivery
   remains unverified for the drill. In production, a controlled
   `set-alarm-state` on 2026-10-26 produced an `Action` item and SNS reported
   1 published / 1 delivered / 0 failed; inbox receipt is still unconfirmed.
   See [alarms.md](alarms.md).
3. **Circuit-breaker coverage for small services.** Rolling back a one-task
   service depends on the deployment alarm. With `BOUNDED_PERCENT` at 50 the
   breaker's threshold stays at 3 until the desired count exceeds 6, so it only
   becomes an independent second line of defence on a notably larger service,
   and that path would need its own drill.
4. **`UnhealthyTargets` and `StructuredErrors` remain deliberately slow** (2 ×
   1 min and 2 × 5 min). They are notification paths, not deployment gates;
   `Request5xx` is the fast one.
