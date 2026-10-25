# Rollback Drill 2 — isolated runbook

Status: **not executed**. No timings, pass/fail result, or production recovery
claim exists.

The production account must not be used to create an intentional outage. The
stack uses fixed resource names (`UniBudgetStack`, `/unibudget/ecs/application`,
`unibudget/supabase/*`), so a second stack in the same account is not a valid
isolated environment.

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

## 6. Cleanup and cost

1. Scale the drill service to zero or destroy the drill stack after evidence is
   captured.
2. Delete drill-only ECR images according to the approved retention policy.
3. Remove the disposable database only after the evidence is exported.
4. Confirm the production account and production stack were never targeted.

## 7. Recorded result

- Executed: **no**
- Date/time: —
- Operator: —
- Drill account: —
- Failure image tag/digest: —
- T0 → detected: —
- T0 → restored: —
- Result: **not run**
