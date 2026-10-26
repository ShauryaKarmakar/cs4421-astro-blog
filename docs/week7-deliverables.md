# Week 7 deliverables — status, evidence, and outstanding work

This is the completion report for the Week 7 CD/operations deliverables. It
separates three things that are easy to conflate:

- **implemented** — the code or workflow exists in this repository;
- **verified** — a named check or read-only AWS call produced evidence;
- **outstanding** — not done yet, with the exact remaining action.

Most AWS facts below come from read-only calls (`Describe*`, `List*`,
`FilterLogEvents`, Logs Insights, the ECR lifecycle-policy preview, and public
HTTPS `GET` requests) made on 2026-10-25. Starting the preview evaluates the
policy but expires nothing. The separate monitoring-stack deployment and the
manual alarm-state notification test were approved writes recorded in section
4. No application deployment, image push, or migration was performed while
preparing this report. Rollback Drill 2 was run separately on 2026-10-26 in the
drill account; §5 records it.

## Summary

| # | Deliverable | Status |
| --- | --- | --- |
| 1 | Automated container CD (tests, Docker build, immutable ECR push, ECS rollout) | **Met** by reusing `.github/workflows/deploy.yml`; tests now run in that workflow |
| 2 | Semantic versioning distinct from immutable image identity | **Partially met** — workflow now enforces semver tags and records digests; `v1.1.0` is the release candidate; no semver-tagged image exists yet and `v1.0.0`/`v1` remain unreconciled |
| 3 | ECS application reachable through the load balancer, `/api/health` works | **Met**, verified through CloudFront. Production runs `v1.1.3`; on 2026-10-26 `/api/health` and `/login` returned 200, `/blog/first-post` 200, and an unknown slug 404 |
| 4 | CloudWatch observability: structured logs, Logs Insights, metrics and alarms | **Met for deployment; partial for proof** — logs and Logs Insights verified; four alarms and an error metric filter are deployed in production and `OK`; CloudWatch executed the SNS action, but inbox receipt is unproven. A real threshold crossing was observed in the drill account on 2026-10-26 (§5) |
| 5 | Rollback Drill 2 | **Met in the drill account on 2026-10-26** — run 1 partial (manual rollback), run 2 automatic (alarm detected in 33 s, rollback in 3 m 10 s). Production is not yet redeployed with the fix; see [rollback-drill-2.md](rollback-drill-2.md) §7–§8 |
| 6 | Outage lifecycle with a blameless post-mortem | **Met** — template, plus a real blameless post-mortem of run 1 in [rollback-drill-2-result.md](rollback-drill-2-result.md); run 2 exercised the corrected path |
| 7 | Release strategy comparison and the strategy actually used | **Met** — ECS rolling with an ECS deployment alarm (the circuit breaker stays enabled but needs three failed launches at this service size) |
| 8 | Evidence mapping | This document |

## 1. Automated container CD

### Reuse decision

There is no `.github/workflows/deploy-container.yml`. The container delivery
pipeline is `.github/workflows/deploy.yml`, and duplicating it would be worse
than reusing it:

- one deploy path means one place where image immutability, the migration
  ordering, the recovery-point attestation, and the production environment
  approval can be enforced;
- two workflows deploying the same `UniBudgetStack` could race and bypass the
  migration-before-rollout rule (the workflow has
  `concurrency: group: unibudget-production, cancel-in-progress: false`);
- the existing workflow already performs the four required actions:
  tests (added in this change), `docker build`, immutable ECR push, and the
  ECS rollout through `cdk deploy` plus `aws ecs wait services-stable`.

The trade-off is that delivery is **manually dispatched** (`workflow_dispatch`)
rather than triggered by a push. That is deliberate: a production deployment
requires an explicit image tag, a desired count, and a verified recovery point.
The CI workflow (`.github/workflows/ci.yml`) runs on every push/PR to `main`
and performs `astro check`, ESLint, Vitest, `astro build`, a Docker build, CDK
build/tests/synth, and a migration-runtime smoke test, so merges are already
gated on the same suite.

### What runs, in order

1. Validate inputs, assume the OIDC role, verify the account, the Supabase
   host, and the CloudFront origin-facing prefix list.
2. `npm ci` (application and CDK).
3. **`npm test -- --run`** — the full application suite; a failure stops the
   run before any image or AWS change.
4. Verify CloudFront delivery and the live `/login` origin.
5. `docker build` and push the immutable tag (`imageTag`), refusing to
   overwrite an existing tag.
6. Validate both task definitions, register the one-off migration revision on
   the new image, run it, wait for `STOPPED`, and deregister it.
7. `cdk deploy` the same `$IMAGE_TAG`, then `services-stable`, running-image
   verification, and `/api/health` plus `/login` through CloudFront.

### Evidence

- Workflow: `.github/workflows/deploy.yml` (18 → 19 steps after adding tests).
- ECR repository is `IMMUTABLE` (`hello-cdk/lib/cdk-stack.ts`).
- The running service uses an image from that repository:
  `.../unibudgetstack-applicationrepository13e54097-nb3o4t9o4cok:v1`
  (`sha256:1a68b6efb71a81456140cbf1a889eb2314e6bfad25b7da1c73654005facc319a`,
  pushed 2026-10-24T23:50:29+01:00).
- ECS rollout evidence: service deployment `rolloutState: COMPLETED`,
  `runningCount: 1`, `desiredCount: 1`, task definition revision 3.

The pipeline run ID for that rollout was not re-read for this report; the
service state and deployment status are the evidence used here.

## 2. Semantic versioning

### Current state (a divergence, deliberately not rewritten)

- An annotated git tag `v1.0.0` exists at commit `95ec16b` (2026-10-12).
- The deployed image is tagged `v1`, pushed 2026-10-24T23:50:29+01:00, digest
  `sha256:1a68b6efb71a81456140cbf1a889eb2314e6bfad25b7da1c73654005facc319a`.
  It is **not** the `v1.0.0` commit and no `v1.0.0` image exists in ECR.
- The image was built from a commit after most of the SemVer tag's history.
  `881376f` (`fix(deploy): separate liveness from readiness and tighten deploy
  gates`, committed 2026-10-24 22:53 +01:00) was HEAD when the image was
  pushed, but the image was built before OCI provenance labels existed, so the
  commit cannot be proven from the artifact. This is recorded as unverified,
  not asserted.
- Moving or force-repointing `v1.0.0` would rewrite published history. Do not
  do it; treat the two identifiers as distinct and reconcile forward at the
  next release.

### Scheme

- A release is an annotated git tag `vMAJOR.MINOR.PATCH`; the next candidate
  is `v1.1.0`.
- The same string is passed to the workflow as `imageTag` and becomes the ECR
  tag of the built image, e.g. `.../unibudget:v1.1.0`.
- ECR tags are immutable, so `v1.1.0` can never be repointed at a different
  image. The **digest** (`sha256:...`) is the content-addressed, immutable
  identity; the semver tag is the human-readable release label.
- The **commit SHA** is recorded by the git tag and as the OCI label
  `org.opencontainers.image.revision`, not as a second ECR tag. A SHA tag
  would double the number of tagged images per release and halve the
  ten-release retention window of the lifecycle policy (`tagged` rule,
  `maxImageCount: 10`), while adding nothing the digest does not already
  provide.
- The release version is recorded as `org.opencontainers.image.version`.
  `.github/workflows/deploy.yml` passes `IMAGE_VERSION="$IMAGE_TAG"` and
  `GIT_REVISION="${GITHUB_SHA:-unknown}"` to `docker build`, and the
  `dockerfile` runtime stage declares both labels. Future images can therefore
  be traced with `docker inspect --format '{{json .Config.Labels}}'` without
  relying on the ECR push timestamp. Images built before this change, including
  `v1`, have no such labels.

### Worked example (documented, not executed)

Deployed image tag: `v1` (verified in section 3). The git tag `v1.0.0` points
at an earlier commit and does not correspond to that image. The next release
candidate is **`v1.1.0`**, not `v2.0.0`: the changes fix the blog route and add
backward-compatible operational hardening, with no breaking API or schema
change. The workflow now rejects non-semver tags and, for a normal deployment,
requires the annotated Git tag to point at the exact commit being built.

```bash
git tag -a v1.1.0 -m "UniBudget v1.1.0"
git push origin v1.1.0
# then dispatch Deploy with:
#   imageTag=v1.1.0
#   desiredCount=<approved count>
#   recoveryPlanVerified=true
#   recoveryPointReference=<verified restore point>
#   recoveryPointTimestamp=<UTC timestamp>
```

The image becomes `...:v1.1.0` with a new digest; the tag and the commit
together answer "which code is running". `v1.1.0` has **not** been released,
and no `v1.1.0` image exists in ECR. The ECR policy correction is complete
and merge-commit CI passed; an approved deployment is still required before
tagging.

### ECR retention and the rollback window

ECR repository: `unibudgetstack-applicationrepository13e54097-nb3o4t9o4cok`
in **us-east-1**. The policy audited before correction was:

```json
{"rules":[{"rulePriority":1,"selection":
  {"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},
  "action":{"type":"expire"}}]}
```

That was **not** the policy declared in `hello-cdk/lib/cdk-stack.ts` (tagged
`*` / 10, untagged / 10). The `v1` push left three manifests in ECR: the
tagged OCI index, its 120.7 MB platform manifest, and a 1.5 KB attestation.
With `tagStatus:"any"` and a count of five, two releases already produce six
manifests, so the rule would start expiring the oldest images. The rollback
history would then be one or two releases, not ten.

On 2026-10-25 the authorized correction was applied through the ECR API, not
through CloudFormation. The live policy is now tagged `*`/10 plus untagged/10;
the read-back matches the policy generated from the merged CDK code. The local
preflight returns `safe: true`, and all three existing manifests remain:

| Field | Result |
| --- | --- |
| Preview status after apply | `COMPLETE` |
| Expiring images | **0** |
| Images in repository | 3 manifests: `v1` (`sha256:1a68b6ef…`, 120.7 MB), plus two untagged (same-size platform manifest and a 1.5 KB attestation) |
| Policy verification | Read-back matches the merged CDK policy byte-for-byte |

The ECR policy change is not reflected in the deployed CloudFormation
template yet. A later `cdk diff` will show a pending repository update until an
approved stack deployment reconciles it. The workflow's read-only preflight
remains in place and fails before the build if the live policy becomes unsafe.

## 3. ECS application availability

Verified on 2026-10-25 through the public CloudFront URL
(`https://d3jsso3b2vz1cp.cloudfront.net`):

| Check | Result |
| --- | --- |
| ECS service status | `ACTIVE` |
| Desired / running / pending | 1 / 1 / 0 |
| Primary deployment | `PRIMARY`, `rolloutState: COMPLETED` |
| Running task definition | `UniBudgetStackApplicationTask3DB06674:3` |
| Running image | `...:v1` |
| `GET /api/live` | **200** |
| `GET /api/health` | **200** `{"status":"ok"}` in 0.375 s |
| `GET /login` | **200** in 0.133 s |
| Unknown blog slug | **500** — same stale-image defect |
| CloudFront distribution | `E30KFH719MS9Z0`, `Deployed`, HTTP-to-HTTPS redirect |
| CloudFront origin | Stack ALB DNS; ALB ingress only from prefix list `pl-3b927c52` |
| CloudFront cache | `Managed-CachingDisabled`; `Managed-AllViewer` |
| Minimum viewer TLS | `TLSv1`; see [cloudfront-tls-plan.md](cloudfront-tls-plan.md) for the separate proposal |

The public path is CloudFront → ALB → target group. The ALB security group
accepts traffic only from the CloudFront origin-facing managed prefix list, so
the ALB was not requested directly; CloudFront is the supported entry point.
The target group probes `/api/health` every 30 s with a 5 s timeout, requires
two consecutive successes to become healthy and three failures to become
unhealthy.

**Known defect at the time of that check:** `/blog/<slug>` returned 500 on
`v1`. The application log stream contains the corresponding stack trace at
2026-10-25 09:53:27 (`[...slug]`, `dist/server/...`). The SSR fix is committed
in `9a5e59c` (2026-10-25) but `v1` was built and pushed on 2026-10-24, so the
fix is not in that image.

**Superseded 2026-10-26:** production now runs `v1.1.3` (task definition
revision 4). A read-only check through CloudFront returned `/api/health` 200,
`/login` 200, `/blog/first-post` 200, and 404 for an unknown slug, so the
defect above no longer describes the running release.

Local validation of the committed fix (not production evidence): the server
was built with `npm run build` and run from `dist/server/entry.mjs` with
`NODE_ENV=development` on 127.0.0.1. The route does not query the database, so
this exercises the SSR path without touching Supabase.

| Request | Result |
| --- | --- |
| `GET /blog/` | **200** |
| `GET /blog/first-post` | **200**, title and `<h1>` render |
| `GET /blog/using-mdx` | **200**, title and `<h1>` render |
| `GET /blog/missing-post` | **404** (not a 500) |
| `GET /blog/first-post/extra` | **404** (rejects the extra segment) |

The deployment workflow now also renders one real entry from
`src/content/blog` after `/api/health` and `/login`, and fails the run on a
non-200. That check is committed in the workflow and covered by
`tests/deployWorkflow.test.ts`; it has not run in GitHub Actions yet.

## 4. CloudWatch observability

### What exists

- Log group: `/unibudget/ecs/application`, retention **7 days**, created by
  `hello-cdk/lib/cdk-stack.ts` and written by the `awslogs` driver.
- Streams observed:
  - `application/ApplicationContainer/72a8d80bfcab4ea092318c484fb1c1a2`
  - `migration/MigrationContainer/3d6880e8d0b04478a98fe490c1366f75`
- Application errors are emitted to stderr as single-line JSON by
  `src/lib/serverLogger.ts`:
  `{"level":"error","event":"...","errorName":"...","code":"..."}` (`code`
  optional). CloudWatch receives both streams through the log driver.

### Logs Insights queries executed

Query 1 (7-day window, `ApplicationContainer` only):

```
fields @timestamp, @logStream, @message
| filter @logStream like /ApplicationContainer/
| sort @timestamp desc
| limit 10
```

Result: `Complete`, 10 rows. The newest entries are the blog-route stack trace
at 2026-10-25 09:53:27, which confirms application output reaches the correct
log group.

Query 2 (structured error schema):

```
fields @timestamp, level, event, errorName
| filter level = "error"
| sort @timestamp desc
| limit 10
```

Result: `Complete`, **0 rows**. A follow-up `@message like /"level":"error"/`
query also returned 0 rows. No request has produced a structured error entry
since the deployment, so the schema is implemented and unit-exercised only
through mocks (`tests/authRoutes.test.ts`); it has not yet been observed in
CloudWatch. This is a gap in evidence, not a claim that logging is broken.

### Metrics worth watching

| Source | Metric |
| --- | --- |
| `AWS/ECS` | `CPUUtilization`, `MemoryUtilization` for the service |
| `AWS/ApplicationELB` | `HealthyHostCount`, `UnHealthyHostCount`, `HTTPCode_Target_5XX_Count`, `TargetResponseTime`, `RequestCount` |
| `AWS/CloudFront` | `5xxErrorRate`, `Requests` |
| `AWS/RDS` (retained instance) | `FreeStorageSpace`, `CPUUtilization`, `DatabaseConnections` |

### Alarms

**Deployed in a separate stack.** `hello-cdk/lib/monitoring-stack.ts` defines
four alarms plus one JSON metric filter and imports the existing log group,
target-group dimensions, and operator-managed SNS topic. It never creates a
topic, log group, ECS, ECR, or IAM resource. Change set
`unibudget-monitoring-20261025-2` created the stack; `-3` replaced the initial
`RunningTaskCount` alarm with `LiveTaskCount` after the former produced a false
alarm because it requires Container Insights. The final stack is
`UPDATE_COMPLETE`, all four alarms are `OK`, and the metric filter is present.
`UniBudgetStack` defines no alarm or metric-filter resources; its test asserts
zero, so an application release cannot recreate the duplicates.

| Alarm | Metric | Threshold / evaluation | Rationale |
| --- | --- | --- | --- |
| Target 5xx | `HTTPCode_Target_5XX_Count` (Sum, 5 min) | `> 5` for 2 periods | Catches a failing release after the target group has already marked tasks healthy |
| Unhealthy targets | `UnHealthyHostCount` (Maximum, 1 min) | `> 0` for 2 periods | The load balancer is routing away from a task; precedes a full outage |
| Live tasks | `LiveTaskCount` (Average, 1 min) | `< desiredCount` for 3 periods | Service capacity is below the requested count; no datapoint is treated as breaching. LiveTaskCount does not require Container Insights |
| Structured errors | `StructuredErrorCount` (Sum, 5 min) | `> 5` for 2 periods | Application errors that do not necessarily surface as 5xx yet |

The metric filter matches `{ $.level = "error" }` on
`/unibudget/ecs/application` and publishes `UniBudget/Application` →
`StructuredErrorCount`. `TreatMissingData` is `notBreaching` for the 5xx,
unhealthy-target, and error alarms, and `breaching` for task count. The separate
stack requires a positive `desiredCount` and always creates the task-count
alarm, so a manual scale to zero would alarm.

Synthesis and tests: `npx cdk synth` produces the four
`AWS::CloudWatch::Alarm` resources and the metric filter in the monitoring
template; the CDK suite passes **27/27**, including threshold, dimension,
filter-pattern, no-action, configured-topic, and no-ECS/ECR/IAM assertions. The
explicit alarm names are `UniBudgetStack-Monitoring-Target5xx`,
`-UnhealthyTargets`, `-LiveTaskCount`, and `-StructuredErrors`, which match the
live SNS topic policy's `UniBudgetStack-*` source condition. A manual
`StructuredErrors` state transition recorded
`Successfully executed action arn:aws:sns:...`; inbox receipt was not
independently verified at that time. A real threshold crossing was later
observed in the drill account (§5), not in production.

Thresholds are intentionally low for a single-task service. A p95 latency
alarm (`TargetResponseTime > 2 s` for 3 periods) and a `HealthyHostCount < 1`
alarm were considered but not added: the unhealthy-target and task-count
alarms already cover zero healthy capacity, and latency has no measured
baseline yet.

## 5. Rollback Drill 2 — EXECUTED (2026-10-26, drill account only)

Two runs were executed in disposable account `293633790894`. Production was not
touched. The canonical record is [rollback-drill-2.md](rollback-drill-2.md)
(§7 run 1, §8 run 2).

| | Run 1 | Run 2 (after fixes) |
| --- | --- | --- |
| Deliberate failure | `/api/health` 500, `/api/live` 200 | same |
| Detection | ALB target health, 1 m 52 s after the task started | `Request5xx` alarm, 33 s after the first failed probe |
| Rollback | manual `ecs update-service` | **automatic**, ECS deployment alarm |
| T0 → healthy | 18 m 27 s | 3 m 10 s |
| Viewer impact | none | none |
| Result | partial | pass, except unverified notification delivery |

Run 1 exposed two real gaps: no alarm could observe a failing readiness probe,
and the single-task service never reached the circuit breaker's effective
threshold of three failed tasks. Run 2 added the `status >= 500` filter, the
`Request5xx` alarm, and the ECS deployment alarm, and demonstrated automatic
rollback with no operator action. Notification delivery is still unverified:
that run captured no `Action` history item.

The procedure below is the pre-drill text, kept for reference. Its
`circuitBreaker`-only expectation was wrong for a one-task service and is now
corrected in [ADR 0006](adr/0006-rolling-deployment-and-rollback.md).

### Prerequisite: an isolated environment (provisioned 2026-10-26)

The CDK stack and the workflow both target the single `UniBudgetStack` name,
the repository is named for that stack, and several resources use fixed names
(`/unibudget/ecs/application`, `unibudget/supabase/*`). A second stack in the
same account would collide on those names, so the only genuinely isolated
option today is a **separate AWS account** with its own CDK bootstrap, ECR,
ALB, CloudFront distribution, and Supabase project/database. That account must
not share the production log group or secrets.

Work required before the drill could run (completed 2026-10-26):

1. Choose a drill account and confirm the deploy role, OIDC trust, and CDK
   bootstrap there (the existing workflow's role ARN is account-specific).
2. Provision the drill stack by hand with `cdk deploy -c desiredCount=0` and a
drill-only image tag; do not point it at production Supabase credentials.
3. Seed a disposable database and confirm `/api/health`, `/login`, and the new
   `/blog/<slug>` check behave the same as production.
4. Record the baseline task definition, digest, desired count, and the
   CloudWatch alarm states.

Using the production stack is **not** an isolated drill. Do not deliberately
break production to obtain timings; if a production exercise is ever wanted,
it needs a separate approved maintenance window and rollback authority.

### Procedure

1. Record the baseline: task definition ARN, image tag/digest, desired count,
   `/api/health` result, and the CloudWatch timestamps.
2. Build and push a deliberately unhealthy image **to the drill account's
   ECR** under a drill-only tag (for example a health endpoint that returns
   503, or a container that exits non-zero). Keep it out of the release tag
   namespace and never push it to the production repository.
3. Deploy that tag with the same pipeline. The ECS **deployment alarm**
   (`deploymentAlarms` with `ROLLBACK_ON_ALARM`) fails the rollout as soon as
   the application reports a 5xx, and the target group marks the new tasks
   unhealthy after three failed probes. The circuit breaker's own threshold is
   three failed tasks, which a one-task service reaches only after repeated
   retries, so it is not the rollback path used here.
4. Observe and timestamp: first failed health probe, `UnHealthyHostCount`
   transition, ECS deployment `FAILED`, rollback start and completion, and the
   moment `/api/health` returns 200 again.
5. Confirm the service is back on the baseline task definition and image, and
   that a second deployment of the baseline still succeeds.
6. Capture: ECS events, deployment JSON before/after, target-group health
   history, relevant log lines, screenshots or CLI output, and the timings.

### Acceptance criteria and record

| Item | Required | Recorded |
| --- | --- | --- |
| Detection latency | < 2 min from unhealthy task start | Run 1: 41 s to first failed probe. Run 2: alarm 33 s after first failed probe |
| Rollback completes without manual intervention | yes | Run 1: **no** (explicit `update-service`). Run 2: **yes** |
| Service healthy again | `/api/health` 200 | Both runs: 200 |
| Traffic impact | no sustained 5xx beyond the probe window | Both runs: public endpoint 200 throughout |
| Baseline restored | same task definition and digest | Both runs: identical digest |
| Start / end time | UTC | Run 1 19:11:37Z–19:30:04Z; run 2 20:32:47Z–20:35:57Z |

Status: **run 1 partial; run 2 pass except unverified notification delivery.**

## 6. Outage lifecycle

### Detection

- The four deployed CloudWatch alarms, ALB target health, and the synthetic
  `/api/health` probe are the primary signals.
- Logs Insights on `/unibudget/ecs/application` for `"level":"error"` finds
  application-side failures; the deployed metric filter feeds
  `StructuredErrorCount` and alerts above five events in ten minutes.
- A user report is a valid detection source, but should not be the only one.

### Triage

1. Is CloudFront serving? `curl -sS -o /dev/null -w '%{http_code}' <ApplicationUrl>/api/health`.
2. Is the target healthy? `aws elbv2 describe-target-health` on the target
   group; `aws ecs describe-services` for `runningCount`, `deployments`, and
   `rolloutState`.
3. Is it the application or its dependency? `/api/health` performs
   `SELECT 1` as the application role; a 503 means the process is up but the
   database path is failing. `/api/live` distinguishes a dead process.
4. Recent change? Compare the running task definition revision/image tag with
   the last known-good release and check the deployment timestamps.
5. Logs: Logs Insights filtered to the failing time window; check
   `health.database.failed`, `middleware.database_role.failed`, and
   `db.*` events.

### Mitigation

- If the current rollout is the cause and has not completed, let the circuit
  breaker roll back; do not scale the service to zero.
- Otherwise redeploy the previous immutable release tag through the workflow
  (it refuses an existing tag, so use the old tag with the stack update path
  in `docs/deployment.md`).
- If the database is the failing dependency, stop the rollout, restore the
  verified Supabase point-in-time backup, then redeploy; migrations are
  forward-only, so record the data-loss window.
- Communicate status and the next update time; do not speculate about cause in
  the public channel.

### Blameless post-mortem template

```
Incident:
Date / duration (UTC):
Severity:
Detection (how and when):
Impact (users, routes, data):
Timeline (UTC, one line per event):
  00:00 detected ...
  00:00 mitigated ...
  00:00 recovered ...
Contributing factors (systems, process, missing guardrails — no individuals):

What went well:
What made it worse:
Action items (owner, due date):
- [ ] detection: ...
- [ ] prevention: ...
- [ ] mitigation speed: ...
```

### Worked example: current blog-route defect

- Detection: application log stack trace for `[...slug]` in
  `/unibudget/ecs/application` (2026-10-25 09:53:27); no alarm fired because
  no alarm was configured at the time.
- Triage: `/api/health` and `/login` return 200, so the process and database
  are healthy; the failure is route-specific and matches the `Astro.props`
  defect fixed in `src/pages/blog/[...slug].astro`.
- Mitigation: the SSR fix is merged (PR #40, `4ce73f9`), and structured
  logging is merged at `a919b96`; CI run 40218210613 passed on that commit.
  The fix was released as `v1.1.3` (merge `c9eb373`, deploy run 40226648129);
  the route now returns 200 through CloudFront. Rolling back to the legacy
  `v1` image in task definition `:3` would restore the 500.
- Contributing factors: no route-level smoke test in the post-deploy check
  (only `/api/health` and `/login`); no alarm on 5xx; the release predates the
  fix.
- Preventive actions: the post-deploy blog-route check is now in
  `.github/workflows/deploy.yml`; the 5xx, unhealthy-target, live-task, and
  structured-error alarms are deployed in `UniBudgetStack-Monitoring`; the
  route regression tests remain in the suite. CloudWatch executed the SNS
  action successfully; inbox receipt is still unproven. A real threshold
  crossing was observed in the drill account on 2026-10-26 (§5).

## 7. Release strategies

| Strategy | How it works | Trade-off | Used by UniBudget? |
| --- | --- | --- | --- |
| Recreate | Stop all old tasks, then start new ones | Simplest; downtime | No |
| Rolling | Replace tasks in batches while keeping a minimum healthy set | No downtime; both versions run briefly; needs health checks | **Yes** |
| Blue/Green | Stand up a full second environment, switch traffic, keep the old one for rollback | Fast rollback; double capacity and more moving parts | No |
| Canary | Send a small percentage of traffic to the new version, then ramp | Best blast-radius control; needs traffic shaping/CodeDeploy-style orchestration | No |

UniBudget uses **ECS rolling deployment** on Fargate:

- `minHealthyPercent: 100`, `maxHealthyPercent: 200`, so a new task must be
  healthy before an old one is removed;
- the `Request5xx` deployment alarm returns the service to the last completed
  deployment as soon as the application reports a 5xx during a rollout;
- `circuitBreaker: { rollback: true }` stays enabled as restart behaviour and a
  second line of defence (its threshold is three failed tasks at this size);
- the ALB target group gates the rollout on `/api/health` (30 s interval,
  2 healthy / 3 unhealthy);
- images are immutable, so a rollback is always a known digest;
- CloudFront uses the `CachingDisabled` policy and forwards cookies/headers,
  so there is no edge cache to purge when the task set changes.

There is no blue/green environment and no canary traffic split. A failed
rollout is observed through the ECS deployment state, target health, and the
`Request5xx` alarm; the deployment alarm performs the rollback automatically
(run 2 reached steady state on the baseline 3 m 10 s after the broken revision
was applied).

## 8. Evidence map and outstanding work

| Deliverable | Implementation | Verification | Status |
| --- | --- | --- | --- |
| Container CD | `.github/workflows/deploy.yml`, `Dockerfile`, ECR repository, ECS service | Tests step added; CI suite; running `v1`; deployment `COMPLETED` | Met (manual dispatch by design) |
| Semver | Semver workflow gate; immutable ECR tags; OCI version/revision labels; digest capture | `v1` tag + digest observed; `v1.1.0` candidate not released; provenance labels not in any image yet | Partial |
| Availability | CloudFront → ALB → `/api/health`; target group probe; post-deploy blog 200 and unknown-slug 404 checks | Production `/api/health` 200, `/login` 200, `/blog/first-post` 200, unknown slug 404 (read-only check 2026-10-26); service 1/1 | Met |
| Observability | `/unibudget/ecs/application`, JSON error logs, separate four-alarm + metric-filter stack, SNS action | Logs Insights executed (10 rows; 0 structured errors); CDK synth + **27/27** tests; monitoring stack `UPDATE_COMPLETE`; four alarms `OK`; alarm history shows successful SNS action | Met for deployment; inbox receipt unproven, threshold crossing shown only in the drill account |
| Rollback Drill 2 | Deployment alarm + circuit breaker + procedure above | Executed twice on 2026-10-26 in the drill account; run 2 rolled back automatically (`drill-evidence-retest/`) | **Met in the drill account**; production redeploy outstanding |
| Outage lifecycle | Detection/triage/mitigation/post-mortem above | Documentation only | Met as documentation |
| Release strategies | Rolling + circuit breaker in CDK | CDK synthesis tests; service config | Met |
| Evidence | This document | Read-only AWS calls on 2026-10-25 | Met |

### Remaining actions before claiming the full checklist

1. Deploy the drill fixes to production in the fixed order: monitoring stack
   first (`Request5xx` + the `status >= 500` filter), then a normal deployment
   (the service needs the alarm as its deployment alarm). Record the first
   production rollout under the new alarm.
2. Verify inbox receipt of the SNS notification, and observe one real threshold
   crossing in production (the drill account demonstrated one on 2026-10-26).
   Resolve the
   ECS/task-definition dynamic changes found in the old `UniBudgetStack`
   no-execute change set; do not execute it, because it would recreate the
   monitoring resources. See [alarms.md](alarms.md).
3. Deploy an image containing the blog SSR fix and verify `/blog/<slug>`
   returns 200 and an unknown slug returns 404 in production; the new
   post-deploy checks must pass on that run.
4. Apply the ECR lifecycle policy before the next push, then release
   `v1.1.0` (not `v2.0.0`) and verify its OCI `version` and `revision` labels
   map to the digest and commit. Do not move `v1.0.0`.
5. Produce one real structured-error log entry in CloudWatch, or add a
   synthetic health check that exercises the error path, to evidence the JSON
   schema in the log group.
6. Replace the verified `AdministratorAccess` attachment on
   `unibudget-github-deploy` with the staged least-privilege policy in
   [iam-least-privilege.md](iam-least-privilege.md), after a non-production
   deployment proves it.
7. Push the hardening branch, verify CI, and merge it before dispatching the
   release. No new branch has been CI-verified yet.
