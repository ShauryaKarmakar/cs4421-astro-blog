# Rollback Drill 2 — isolated runbook

Status: **not executed**. No timings, pass/fail result, or production recovery
claim exists. Runbook revised 2026-10-26 for reproducibility; the status is
unchanged.

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

## 2. Prerequisites

1. Approve the drill account and its cost/time budget.
2. Bootstrap CDK and create the drill stack with `bootstrapOnly` or
   `desiredCount=0`.
3. Confirm the drill CloudFront URL, `/api/health`, `/login`, and a real
   `/blog/<slug>` return the expected status.
4. Record the baseline task definition ARN, image tag, **image digest**,
   desired count, and alarm states.
5. Confirm the drill database is disposable and has a restore point or can be
   recreated from migrations.

### Preparation status

| Prerequisite | Status | Evidence still needed |
| --- | --- | --- |
| Separate AWS account approved | **Not confirmed** | Account ID and approval record |
| Drill CDK bootstrap and deploy role | **Not confirmed** | `CDKToolkit` stack and role ARN |
| Drill stack deployed with `desiredCount=0` | **Not confirmed** | Stack status and service `desiredCount` |
| Drill ECR repository and baseline image | **Not created** | Repository URI and baseline image digest |
| Disposable drill database | **Not created** | Database host/project reference; no production data |
| Baseline route statuses recorded | **Not started** | `/api/health`, `/login`, real and unknown blog slug |
| Drill-only failing image | **Not built** | Local image ID and tag `v0.0.0-drill.1`; not pushed |

The runbook is ready, but the drill cannot start until the first five rows have
evidence. Do not substitute the production account or production database for
any row.

### Permissions required in the drill account

| Capability | Needed for |
| --- | --- |
| `ecr:*` on the drill repository | Push the drill-only image |
| `ecs:RegisterTaskDefinition`, `ecs:UpdateService`, `ecs:Describe*` | Deploy the drill image and read deployment state |
| `iam:PassRole` for the drill task/execution roles | Start the drill task |
| `cloudwatch:DescribeAlarms`, `cloudwatch:GetMetricData`, `logs:FilterLogEvents` | Observe failure and recovery |
| `cloudformation:DescribeStacks`, `cloudfront:GetDistribution` | Record stack and edge state |

No permission is required in the production account.

## 2a. Exact rollback path under test

The architecture is a single ECS service with the rolling deployment controller
and `circuitBreaker: { rollback: true }` (ADR 0006). There is no traffic switch.
The automatic path is:

1. The new task fails its container health check or the ALB readiness check.
2. ECS stops replacing healthy tasks and the deployment enters a failed state.
3. The circuit breaker rolls the service back to the last `COMPLETED` task
   definition revision.
4. `rolloutState` returns to `COMPLETED` on the baseline revision.

The manual equivalent, only if the automatic path does not fire in the drill
account, is to point the service back at the baseline revision:

```bash
# Drill account only. Never run this against the production service.
aws ecs update-service \
  --cluster "$DRILL_CLUSTER" \
  --service "$DRILL_SERVICE" \
  --task-definition "$BASELINE_TASK_DEFINITION"
aws ecs wait services-stable \
  --cluster "$DRILL_CLUSTER" \
  --services "$DRILL_SERVICE"
```

Record which path actually recovered the service. A manual recovery still
satisfies the availability criteria but fails criterion 2 (automatic rollback)
and must be reported as such.

Baseline capture commands (read-only):

```bash
aws ecs describe-services --cluster "$DRILL_CLUSTER" --services "$DRILL_SERVICE" \
  --query 'services[0].{taskDefinition:taskDefinition,rollout:deployments[0].rolloutState,desired:desiredCount,running:runningCount}' \
  --output json > baseline-service.json
aws ecs describe-task-definition --task-definition "$BASELINE_TASK_DEFINITION" \
  --query 'taskDefinition.containerDefinitions[0].image' --output text
```

Store the JSON evidence with the drill record; do not store credentials or
secret values.

## 3. Controlled failure

Build a drill-only image that fails its container health check, for example a
process that exits immediately or serves 503 from `/api/live`. Push it to the
drill ECR under a non-release tag such as `v0.0.0-drill.1`. Never push it to
the production repository.

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

## 5. Acceptance criteria

| Criterion | Required | Observed |
| --- | --- | --- |
| Detection latency | under 2 minutes from failed task start | — |
| Rollback without manual task-definition change | yes | — |
| Restored digest equals baseline digest | yes | — |
| `/api/health` returns 200 after recovery | yes | — |
| `/login` and the blog route return the expected status | yes | — |
| No sustained 5xx beyond the probe window | yes | — |
| Evidence timestamps in UTC | yes | — |

If any row is blank, the drill is not complete. Do not infer timings from
CloudWatch retention or reconstruct them later.

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

## 7. Recorded result

- Prerequisite status: the isolated account, bootstrap, disposable database,
  and drill ECR repository are **not yet confirmed**. The PR #40 merge and
  merge-commit CI success do not satisfy these prerequisites; no failure
  simulation has been run.
- Executed: **no**
- Date/time: —
- Operator: —
- Drill account: —
- Failure image tag/digest: —
- T0 → detected: —
- T0 → restored: —
- Result: **not run**
