# UniBudget release readiness

Last updated: 2026-10-25 (production state); rollback-drill section added 2026-10-26

This document separates what is implemented from what is tested, merged,
deployed, and verified in production. A green local suite is not a deployment.

## Current baseline

| Item | State |
| --- | --- |
| `main` | `a919b96` — merge of PR #41 (structured logging) after PR #42 (alarm identity); PRs #39/#40 remain in history |
| Hardening branch | `feat/final-project-hardening` at `50d30cc`; merged via PR #40; merge-commit CI passed |
| Production image | `v1.1.3`, digest `sha256:168b26…`, task definition revision 4 (verified read-only 2026-10-26) |
| ECS service | `ACTIVE`, desired 1 / running 1, primary deployment `COMPLETED` |
| `/api/health` | **200** |
| `/login` | **200** |
| `/blog/first-post` | **200** (verified read-only 2026-10-26) |
| CloudWatch alarms | **four deployed** in `UniBudgetStack-Monitoring`, all `OK` at the final read-back; one metric filter deployed |
| SNS topics | `unibudget-production-alarms` exists with its reviewed policy and one confirmed email subscription; CloudWatch executed its action successfully |
| Monitoring stack | `UniBudgetStack-Monitoring` is `UPDATE_COMPLETE` (2026-10-25 17:39 UTC); change sets `unibudget-monitoring-20261025-2` and `-3` executed |
| Deploy role | `unibudget-github-deploy` with `AdministratorAccess` |
| CloudFront | `E30KFH719MS9Z0`, `Deployed`, HTTPS redirect, origin is the UniBudget ALB, minimum viewer TLS `TLSv1`; see [cloudfront-tls-plan.md](cloudfront-tls-plan.md) |
| ECR policy | **safe**: tagged `*`/10 and untagged/10, applied out-of-band 2026-10-25; preview reports 0 expiring |
| ECR images | immutable tags; production runs `v1.1.3` (baseline above); the legacy `v1` tag stays unreconciled |
| Rollback Drill 2 | **executed twice on 2026-10-26** in drill account `293633790894`: run 1 partial (manual rollback), run 2 automatic. Production unchanged; see below |

Read-only checks on 2026-10-25 confirmed the production service and route
status above. No **application** deployment was performed; the separate
monitoring stack was deployed in a distinct approved operation. The logging and
hardening work is merged at `a919b96`; CI on that merge commit completed
successfully in
[run 40218210613](https://github.com/ShauryaKarmakar/cs4421-astro-blog/actions/runs/40218210613).
The monitoring-ownership reconciliation described below is prepared in the
worktree and is not part of `a919b96`.

## Rollback drill execution (2026-10-26)

Two runs were executed in disposable account `293633790894`; production was not
touched, and this section does not change the production rows above.

| | Run 1 | Run 2 (after the fixes) |
| --- | --- | --- |
| Failure | `/api/health` 500, `/api/live` 200 | same |
| Detection | ALB target health, 1 m 52 s after the task started (2 m 5 s from T0) | `Request5xx` alarm, 33 s after the first failed probe |
| Rollback | manual `ecs update-service` | automatic, ECS deployment alarm |
| T0 → healthy | 18 m 27 s | 3 m 10 s |
| Viewer impact | none; public 200 throughout | none |
| Result | partial | pass, except unverified notification delivery |

Run 1 exposed two gaps: no alarm could see a failing readiness probe, and the
single-task service needed three failed launches to reach the circuit breaker's
threshold, so recovery was manual. Run 2 added a `status >= 500` metric filter,
the `Request5xx` alarm (1 × 1 min, `> 0`), and an ECS deployment alarm that
rolls back on `ALARM`. Evidence: `drill-evidence/` (run 1) and
`drill-evidence-retest/` (run 2); the record is
[rollback-drill-2.md](rollback-drill-2.md).

Production still runs the previous monitoring stack: four alarms, no
`Request5xx`, and a service with no deployment alarm. Applying the fix needs the
monitoring stack deployed first, then a normal deployment. The workflow now
verifies the alarm before it builds or migrates, passes it to the stack, and
fails the release if the service is not watching it.

## CloudFront verification

| Check | Observed |
| --- | --- |
| Distribution | `E30KFH719MS9Z0`, status `Deployed`, enabled |
| Public hostname | `d3jsso3b2vz1cp.cloudfront.net`; no aliases or custom domain |
| Viewer protocol | `redirect-to-https`; HTTP `/api/health` returned **301** to HTTPS |
| Origin | The UniBudget ALB DNS name from the stack output |
| Origin protocol | HTTP-only to the ALB; ALB listener is HTTP/80 and security group ingress is only prefix list `pl-3b927c52` |
| Cache behavior | `Managed-CachingDisabled`; origin request policy `Managed-AllViewer`; seven methods allowed |
| Certificate | CloudFront default certificate; minimum viewer TLS is **`TLSv1`** |
| Route: `/api/live` | **200** |
| Route: `/api/health` | **200** |
| Route: `/login` | **200** |
| Route: `/blog/first-post` | **200** (re-checked 2026-10-26; was 500 on the older `v1` image) |
| Route: unknown blog slug | **404** (re-checked 2026-10-26; was 500 on `v1`) |

The CloudFront origin, HTTPS redirect, cache policy, and ALB-only-via-CloudFront
network path match the intended architecture. The `TLSv1` minimum viewer
protocol is a security weakness recorded for later review; it was not changed
in this task.

AWS documents that the default `*.cloudfront.net` certificate automatically
sets the viewer security policy to `TLSv1`. A modern policy such as
`TLSv1.2_2021` requires a custom SSL certificate, an alternate domain name, and
SNI. The separate proposal in
[cloudfront-tls-plan.md](cloudfront-tls-plan.md) records the exact current
configuration, recommends `TLSv1.2_2021` with an ACM certificate in `us-east-1`
and a custom domain, and lists the DNS, cookie/session, compatibility, rollback,
and application-stack-dependency risks. It is **not applied** and is not part
of the monitoring deployment.

## Readiness matrix

| Area | Implemented | Locally tested | CI verified | Deployed | Verified in production |
| --- | --- | --- | --- | --- | --- |
| Blog SSR route | yes | yes (unit + built-server 200/404) | yes (merge commit) | yes, in `v1.1.3` | **yes — 200 for a real slug, 404 for an unknown slug** |
| Liveness/readiness split | yes | yes (unit + Docker runtime) | yes (merge commit) | yes, in `v1.1.3` | `/api/live` 200, `/api/health` 200 |
| Deployment test gate | yes | yes (contract) | yes (merge commit) | n/a | n/a |
| Post-deploy health/login/blog/404 checks | yes | yes (contract; local route check) | yes (contract) | no | no |
| Image provenance labels | yes | contract test | yes (contract) | no | no |
| Semantic tag validation | yes | yes (unit + workflow contract) | yes (merge commit) | no | no |
| Tag-to-commit enforcement | yes | yes (workflow contract) | yes (merge commit) | no | no |
| ECR retention preflight | yes | yes (policy unit + live read-only) | yes (merge commit) | applied out-of-band, not yet reconciled by the stack | preflight `safe: true`; preview reports 0 expiring |
| CloudWatch alarms + metric filter | yes | CDK 37/37 (27/27 at the 2026-10-25 review) | yes (merge commit) | **yes, separate stack** | four alarms and one filter present in production; `Request5xx` and its filter exist in code but are not deployed |
| SNS notification action | yes | CDK tests | yes (merge commit) | **yes** | alarm history records a successful SNS action; inbox receipt not independently verified |
| CDK ADRs and runbooks | yes | documentation review | n/a | n/a | n/a |
| Least-privilege deploy role | proposal only | n/a | no | no | role has `AdministratorAccess` |
| Rollback Drill 2 | yes (runbook + fixes) | n/a | no | **drill account only** | executed twice 2026-10-26; run 2 rolled back automatically. Production still lacks `Request5xx` |

## Local verification performed on the hardening branch

- `npm test -- --run` with a disposable local PostgreSQL 16 container:
  **229 passed, 0 failed, 0 skipped** across 27 files. This includes the two
  PostgreSQL integration suites, which skip only when no test database is
  configured.
- `tests/blogRoute.test.ts`: **11 passed / 11** after adding an assertion that
  the unknown-slug branch sets `Astro.response.status = 404`. The 229-test run
  above predates that one added assertion; no other test changed.
- `npm run check`: 0 errors, 0 warnings, 0 hints.
- `npm run lint`: 0 errors, 6 pre-existing `no-console` warnings in diagnostic
  scripts and ignored `artifacts/`.
- `npm run build`: succeeded with the Node standalone adapter.
- Built server (`node scripts/start.mjs`, local port): `/blog/first-post`
  **200** with the expected title and body, an unknown slug **404**, extra or
  malformed path segments **404**, `/api/live` **200**.
- CDK Jest: **27/27 passed** across the application-stack and separate
  monitoring-stack suites. `cdk synth` succeeded for both templates. The
  monitoring template contains exactly four alarms and one metric filter,
  creates no SNS topic, log group, ECS, ECR, or IAM resource, and names the
  alarms under `UniBudgetStack-Monitoring-*`.
- `docker build` from `dockerfile`: succeeded; OCI version/revision labels
  carried the supplied release string and `GITHUB_SHA` equivalent. The runtime
  image answered `/api/live` **200** and `/api/health` **503** with no database
  configuration, proving liveness and readiness are independent.
- Both workflow files parse as YAML and all 28 embedded `run` blocks pass
  `bash -n`.
- The live ECR policy failed the new preflight before correction. The
  ten/ten policy generated from the merged CDK code was applied out-of-band
  on 2026-10-25 and now passes the preflight; a lifecycle preview reports
  **0 expiring images**. The live repository, ECS service, image digest,
  alarms, and production routes were re-checked read-only on 2026-10-25.
- The ECR policy was applied through the ECR API, not through CloudFormation.
  The live resource now matches the merged CDK policy, but the deployed stack
  template still records the old value, so a later `cdk diff` will show a
  pending repository update until an approved stack deployment reconciles it.
- An earlier monitoring-only `cdk diff` against `UniBudgetStack` proposed five
  new resources plus one ECR policy modification. Its no-execute change set
  (`unibudget-monitoring-20261025-1`) then exposed hidden dynamic changes: the
  ECS service `TaskDefinition` reference, both task definitions'
  `ContainerDefinitions`, and both task execution-role default policies, all
  caused by `ApplicationRepository13E54097.Arn`. That change set was **not
  executed** and remains `AVAILABLE`; it is evidence of the application-stack
  coupling, not an approved deployment path.
- The separate `UniBudgetStack-Monitoring` stack was deployed after approval.
  Change set `unibudget-monitoring-20261025-2` created four alarms, one metric
  filter, and `CDKMetadata`, with no ECS, ECR, IAM, SNS, or log-group change.
  The initial `RunningTaskCount` alarm had no datapoints because that metric
  requires Container Insights; it briefly went `ALARM`. Change set
  `unibudget-monitoring-20261025-3` replaced it with `LiveTaskCount`, an ECS
  service-utilization metric that is available without Container Insights.
  The final stack is `UPDATE_COMPLETE` with all four alarms `OK`. The physical
  names are `UniBudgetStack-Monitoring-Target5xx`, `-UnhealthyTargets`,
  `-LiveTaskCount`, and `-StructuredErrors`, matching the live SNS topic
  policy's `UniBudgetStack-*` source condition.

Re-verified on 2026-10-26 against the current worktree:

- `npx vitest run` with no database: **277 passed, 6 skipped** in 31 files.
- With `BUDGET_TEST_DATABASE_URL` and `MIGRATION_TEST_DATABASE_URL` pointing at
  a disposable PostgreSQL 16 container on `127.0.0.1:5433` (not production, not
  Supabase): **283 passed, 0 failed**. The migration suite applies the project's
  migrations to throwaway databases it creates and drops itself.
- `hello-cdk` Jest: **37 passed, 0 failed** across three suites.
- CloudWatch-to-SNS delivery was exercised with a manual `StructuredErrors`
  state transition. Alarm history at 2026-10-25 17:34:53 UTC records
  "Successfully executed action
  arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms". The alarm
  was restored to `OK`; inbox receipt was not independently verified.

## Status ladder

These are separate states. A later state is not implied by an earlier one.

| State | Current status |
| --- | --- |
| 1. Code complete | Yes for the application, health, structured logging, workflow, separate monitoring stack, lifecycle, provenance, ADR, and runbook work. Logging and the SSR blog-route fix are merged in `a919b96`; the monitoring-ownership reconciliation and workflow cleanup are prepared in the worktree but not yet committed. IAM least privilege and CloudFront custom-domain TLS remain proposals, not completed external changes; Rollback Drill 2 was executed in the drill account on 2026-10-26 (see below). |
| 2. Locally tested | Yes. The release candidate (`a919b96` + the prepared reconciliation) ran at **242 Vitest tests in 28 files**; the current worktree runs **283 tests in 31 files**: 277 pass with no database, and all 283 pass when both PostgreSQL integration suites run against a disposable PostgreSQL 16 container (verified 2026-10-26 on this Windows host at the default timeout). **37 CDK tests** now (27 at the 2026-10-25 review), `astro check` 0 errors/0 warnings/0 hints, ESLint clean, Astro build, workflow YAML parse, CDK synthesis for both stacks, Docker build, and container route checks. The blog route file has 11 tests, including the 404-status assertion. |
| 3. CI verified | **Yes** for merge commit `a919b96`: CI run [40218210613](https://github.com/ShauryaKarmakar/cs4421-astro-blog/actions/runs/40218210613) completed successfully (all 19 steps). |
| 4. Ready for deployment | **No** for the application. See the explicit blockers below. The separate monitoring stack is already deployed. |
| 5. Deployed | **No** for the application; production still runs the legacy `v1` image. **Yes** for `UniBudgetStack-Monitoring`. |
| 6. Verified in production | **Yes for the routes checked on 2026-10-26**: `/api/health` 200, `/login` 200, `/blog/first-post` 200, unknown slug 404, running image `v1.1.3`. **Partially yes** for monitoring: four alarms and one filter exist, all `OK`, and CloudWatch executed the SNS action; inbox receipt is not proven, and no threshold crossing has occurred in production (one was observed in the drill account on 2026-10-26). |

## Release candidate

The next release should be **`v1.1.0`**, not `v2.0.0`:

- the changes fix the `/blog/:slug` 500 and add operational hardening and
  observability without changing the public API or database schema contract;
- `v1.0.0` already exists and must not be moved;
- the deployed `v1` is a legacy image with unproven provenance;
- a minor version records new backward-compatible capability while avoiding a
  false major-version claim.

The release tag, ECR tag, OCI `version`, and recorded digest must all be
`v1.1.0`. Do not create or push the tag until the code is merged, CI is green,
and the remaining release blockers are cleared.

## Required sequence before the next production release

1. **Use the merged logging/hardening commit as the release base.** PRs #40,
   #41, and #42 are merged and CI passed on `a919b96`; the release must be
   built from that commit combined with this reviewed monitoring reconciliation,
   not from an unmerged branch or a stale image.
2. **ECR lifecycle policy — completed out-of-band.** The audited live
   `tagStatus: any`/5 policy was replaced on 2026-10-25 with the merged CDK
   policy: tagged `*`/10 and untagged/10. The read-back passes the preflight
   and a lifecycle preview reports 0 expiring images. The deployment workflow
   still runs its pre-push gate. CloudFormation has not reconciled the change,
   so review the next `cdk diff` before a stack deployment.
3. **SNS notification path — topic, policy, and subscription confirmed.**
   The topic is `arn:aws:sns:us-east-1:556890483680:unibudget-production-alarms`.
   Its policy is scoped to `cloudwatch.amazonaws.com`, `sns:Publish`, that exact
   topic, and alarms under `UniBudgetStack-*`. One email subscription is
   confirmed with a real ARN. The monitoring stack uses the topic directly;
   the application stack no longer accepts `alarmTopicArn` and the deploy
   workflow no longer passes that context. See
   [alarms.md](alarms.md). CloudWatch executed the SNS action successfully;
   inbox receipt is not independently verified.
4. **Alarms deployed through the separate stack — completed.**
   `UniBudgetStack-Monitoring` is `UPDATE_COMPLETE` with four alarms and one
   metric filter. It imports the existing log group, target-group dimensions,
   and SNS topic and did not update `UniBudgetStack`, ECS, ECR, IAM, the log
   group, or the SNS topic. The initial `RunningTaskCount` alarm was replaced
   with `LiveTaskCount` after it produced a false alarm; all four alarms are
   `OK`. The application stack no longer defines alarm or metric-filter
   resources; its test asserts zero. The old `UniBudgetStack` change set
   `unibudget-monitoring-20261025-1` no longer exists: a read-only check on
   2026-10-26 lists no change sets for any production stack, so there is nothing
   to execute and nothing to clean up.
   Do not use the `Deploy` workflow for monitoring: it builds and pushes an
   image and runs migrations.
5. **Choose the release commit and tag.** Create annotated tag `v1.1.0` on the
   merged commit and push it. Do not move `v1.0.0`. The deployment workflow
   now refuses a normal release unless that annotated tag exists and points at
   the exact `GITHUB_SHA` being built; dispatch it from that commit.
6. **Deploy through the workflow.** Provide the verified recovery point,
   `imageTag=v1.1.0`, and an explicit desired count. The workflow builds,
   pushes, records the digest, migrates, deploys, and verifies the running
   digest plus `/api/health`, `/login`, a real blog slug, and an unknown-slug
   404.
7. **Verify in production.** Confirm the new digest and the blog route over
   CloudFront, and confirm a test alarm notification if the SNS path was
   enabled.
8. **Re-check rollback readiness after the production release.** Rollback
   Drill 2 ran on 2026-10-26; the deployment alarm it validated reaches
   production with the monitoring stack and this release.

## Release plan (prepared, not executed)

> **Superseded — verified 2026-10-25.** Production runs `v1.1.3` on task
> definition revision 4 (`sha256:168b26…`), not the `v1.1.0` in the plan below.
> Treat this section as historical; current release facts, evidence commands
> and the rollback candidate are in [chaos-drill.md](chaos-drill.md) and
> [logging.md](logging.md).

Target: **`v1.1.0`**, annotated, on the merge commit of this reconciliation on
`main` (a descendant of `a919b96`). No tag or image exists yet. Do not move
`v1.0.0` (`95ec16b`).

1. Merge the reviewed reconciliation after CI passes. Record the merge SHA.
2. Create and push an annotated tag on that exact SHA:
   `git tag -a v1.1.0 -m "UniBudget v1.1.0" <merge-sha>` then
   `git push origin v1.1.0`. The workflow rejects a lightweight tag, a
   non-semver tag, or a tag that does not point at the checked-out `GITHUB_SHA`.
3. Dispatch `Deploy` from `main` at that SHA with `imageTag=v1.1.0`,
   `desiredCount=1`, `recoveryPlanVerified=true`, and a
   verified Supabase recovery-point reference and UTC timestamp. The workflow
   runs tests before the image build, checks ECR retention before the push,
   records the digest and OCI labels, runs the migration before the rollout,
   deploys the immutable tag, and verifies the running digest, `/api/health`,
   `/login`, a real blog slug, and an unknown-slug 404.
4. Capture every row of the evidence checklist below, including the four
   `UniBudgetStack-Monitoring-*` alarms and the JSON access/error records with
   the same `requestId`.

**Rollback.** The prior application revision is
`UniBudgetStackApplicationTask3DB06674:3` (image `v1`). If the release fails
verification, update the service back to that revision, wait for a stable
service, and re-check `/api/live`, `/api/health`, `/login`, the blog route, and
the running digest. `v1.1.0` adds no migration, so rolling back is
schema-compatible; the smoke-test rows for blog 200/404 will return to the
legacy 500 until the fix is redeployed. If the workflow fails after pushing the
image, the immutable `v1.1.0` tag cannot be reused; publish `v1.1.1`. Rollback
Drill 2 was a separate activity in the isolated account and is recorded in
[rollback-drill-2.md](rollback-drill-2.md) §7–§8.

## Release evidence checklist

Record a value for every row. A release is not complete while any row is
blank; a green build alone proves none of the deployed behavior.

| Gate | Evidence to capture | Pass condition |
| --- | --- | --- |
| Release base | `git rev-parse HEAD`, `git show -s --format=%s` | Reviewed commit on `main`, at or after `a919b96` |
| CI | GitHub Actions run URL for the release base | Required `test` job succeeds on that exact SHA |
| ECR policy | `aws ecr get-lifecycle-policy` plus `assessLifecyclePolicy` output | `safe: true` before the image push |
| Image | ECR tag, image digest, OCI `version`/`revision` labels | `v1.1.0` tag and digest recorded; labels match the release commit |
| Migration | Workflow step result and migration log | Completed before the new task definition serves traffic |
| Deployment | ECS service deployment ID and rollout state | `COMPLETED`, desired count equals running count |
| Running artifact | `aws ecs describe-tasks` image digest | Equals the recorded release digest |
| Health | `/api/health` over CloudFront | HTTP 200 |
| Login | `/login` over CloudFront | HTTP 200 |
| Real blog slug | `/blog/first-post` over CloudFront | HTTP 200 with the expected title |
| Unknown blog slug | `/blog/definitely-not-a-post` over CloudFront | HTTP 404, not 500 and not 200 |
| Alarms | `aws cloudwatch describe-alarms --alarm-name-prefix UniBudgetStack-Monitoring-` | Four alarms present, all `OK` at steady state, with `AlarmActions` set |
| Notification | SNS subscription ARN and alarm-history action evidence | Subscription confirmed (`SubscriptionArn` is an ARN); alarm history shows `Successfully executed action arn:aws:sns:...`; inbox receipt noted separately |
| Rollback | Rollback Drill 2 result in the isolated account (`rollback-drill-2.md` §8) | Run 2 meets every criterion except verified notification delivery |

## Explicit blockers

- Resolved on 2026-10-25: production now runs `v1.1.3` and `/blog/<slug>` returns 200 with an unknown slug returning 404 (re-verified read-only 2026-10-26).
- Monitoring is deployed but not fully proven: CloudWatch executed the SNS
  action, but inbox receipt was not independently verified. The 2026-10-26 drill
  did produce a real threshold crossing in the drill account, but that run's
  evidence captured no `Action` history item, so notification delivery from it
  is unverified too. The initial `RunningTaskCount` alarm produced a false alarm
  and was replaced with `LiveTaskCount`.
- CloudFront still enforces only `TLSv1` on the default certificate. A modern
  policy requires a custom domain and ACM certificate; the separate proposal
  is prepared but not applied.
- The old `UniBudgetStack` change set exposed dynamic ECS service,
  task-definition, and IAM-policy modifications; it was not executed and
  remains a blocker for any application-stack update.
- `UniBudgetStack` no longer defines alarms or a metric filter; its test
  asserts that absence. It does reference one alarm **by name** in the ECS
  deployment configuration. The old change set would recreate duplicates if
  executed.
- The deployment role still has `AdministratorAccess`; least privilege is a
  proposal, not applied.
- No `v1.1.0` tag or image exists.
- The repository variable `ALARM_TOPIC_ARN` cannot be read without an
  authenticated GitHub session (the API returns 401). The application workflow
  no longer uses it, so it is not a release blocker; it is only needed for a
  manual monitoring-stack deployment.
- Production has not been redeployed with the drill fixes: `Request5xx`, the
  `status >= 500` filter, and the ECS deployment alarm exist in code and in the
  drill account only. Applying them needs the monitoring stack first, then a
  normal deployment.
- The monitoring-ownership reconciliation has not been released: production
  runs `v1.1.3` from `a919b96`, whose image predates it. The separate monitoring
  stack is deployed, but from the four-alarm version.

## Operations deliberately not performed and separate writes

No application deployment, image push, release tag, migration, IAM change,
GitHub secret/variable change, DNS/certificate change, or rollback drill was
performed while preparing this document. (A rollback drill was later executed
in the separate drill account on 2026-10-26; see
[Rollback drill execution](#rollback-drill-execution-2026-10-26). Production
was still not touched.) The authorized AWS writes were the
ECR lifecycle-policy replacement, the SNS topic/policy/subscription setup, and
the separate monitoring-stack deployment on 2026-10-25. Change sets
`unibudget-monitoring-20261025-2` and `-3` were executed; they created four
alarms and one metric filter, then replaced the false-alarm
`RunningTaskCount` alarm with `LiveTaskCount`. A manual `StructuredErrors`
state transition was used for CloudWatch-to-SNS evidence and was restored to
`OK`; no production error was generated. The application stack was not
updated at that time: its last update remains 2026-10-24 22:59:56 UTC, and ECS
stayed at desired 1 / running 1. The no-execute change set
`unibudget-monitoring-20261025-1` was never executed, and it was gone by the
2026-10-26 check that listed no change sets for any production stack. The
CloudFront TLS proposal in [cloudfront-tls-plan.md](cloudfront-tls-plan.md) is
documentation only; the distribution still reports `TLSv1` and the default
certificate. The PR #40 merge and these AWS changes were performed separately
from this documentation; none of them deploys the application.
