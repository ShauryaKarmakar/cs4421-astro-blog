# UniBudget release readiness

Last updated: 2026-10-26

This document separates what is implemented from what is tested, merged,
deployed, and verified in production. A green local suite is not a deployment.

## Current production baseline

| Item | State |
| --- | --- |
| `main` (current) | `d22cce4` — static-deploy test database fix; no release since `v1.1.3` |
| Release commit | `c9eb373` — merge of PR #46 (CloudFront origin gate) |
| Release tag | annotated `v1.1.3` on `c9eb373` |
| Release run | [Deploy 40226648129](https://github.com/ShauryaKarmakar/cs4421-astro-blog/actions/runs/40226648129) — **success** |
| Merge-commit CI | [CI 40226500423](https://github.com/ShauryaKarmakar/cs4421-astro-blog/actions/runs/40226500423) — **success** |
| Production image | ECR `v1.1.3`, digest `sha256:168b26f56a7d5821eb6b947e4335bc31d4ce7cb4fc8060a1327cbdfd1a0fa61c` |
| ECS task definition | `UniBudgetStackApplicationTask3DB06674:4` |
| ECS service | `ACTIVE`, desired 1 / running 1, primary deployment `COMPLETED`, container `HEALTHY` |
| CloudFormation | `UniBudgetStack` `UPDATE_COMPLETE`, last updated 2026-10-25 19:37 UTC |
| `/api/health` | **200** |
| `/api/live` | **200** |
| `/login` | **200** |
| `/blog/first-post` | **200** with the expected title |
| Unknown blog slug | **404** |
| `/` | **200** |
| CloudWatch alarms | **five** deployed in `UniBudgetStack-Monitoring` since 2026-10-26, all `OK` |
| SNS topic | `unibudget-production-alarms`, one confirmed email subscription |
| CloudFront | `E30KFH719MS9Z0`, `Deployed`, HTTPS redirect, one ALB origin, cache disabled, viewer TLS `TLSv1` |
| ECR images | four manifests: `v1.1.3`, `v1`, and two untagged |
| ECR retention | tagged `*`/10 and untagged/10; preflight passed before the push |
| Rollback Drill 2 | **executed twice on 2026-10-26** in drill account `293633790894`: run 1 partial (manual rollback), run 2 automatic. Its fixes were then deployed to production; see below |
| Deployment alarm | `UniBudgetStack-Monitoring-Request5xx` attached to the ECS service with `rollback: true`, `enable: true` (applied 2026-10-26); circuit breaker still enabled |

The run built and pushed the immutable image, completed the one-off migration
task, deployed the stack, waited for a stable service, verified the running
digest, and passed the post-deploy `/api/health`, `/login`, real blog slug, and
unknown-slug 404 checks through CloudFront. The read-back above was performed
separately after the run.

## Rollback Drill 2 (2026-10-26, drill account only)

Two runs were executed in disposable account `293633790894`; production was not
touched, and nothing below changes the production rows above.

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
the `Request5xx` alarm (1 × 1 min, `> 0`), and an ECS deployment alarm that rolls
back on `ALARM`. Evidence: `drill-evidence/` (run 1) and
`drill-evidence-retest/` (run 2); the record is
[rollback-drill-2.md](rollback-drill-2.md).

## Deployment to production (2026-10-26)

The drill fixes were applied to the production account in the required order,
with a read-only `cdk diff` inspected before each write.

1. `UniBudgetStack-Monitoring` was updated first: the diff was exactly two
   additions (`Application5xxMetricFilter` and `Request5xxAlarm`), and the stack
   reached `UPDATE_COMPLETE` in 13 s. `Request5xx` measures
   `UniBudget/Application` `Http5xxCount` as `Sum > 0` over one 60 s period,
   with `notBreaching` and the production SNS topic as its action.
2. `UniBudgetStack` was updated second: the diff was one change, `.Alarms`
   added to the ECS service's `DeploymentConfiguration`. No task-definition,
   image, ECR, network, or IAM change was proposed. The stack reached
   `UPDATE_COMPLETE` in 51 s, and the task definition stayed at revision `:4`.

After the rollout, `describe-services` reports `desired 1 / running 1`, primary
rollout `COMPLETED`, and `deploymentConfiguration.alarms` listing
`UniBudgetStack-Monitoring-Request5xx` with `rollback: true` and `enable: true`,
alongside the enabled circuit breaker. At deploy time a repeat `cdk diff` of
both stacks reported no differences; the monitoring stack was diffed again on
2026-10-26 23:57 UTC with "There were no differences". The alarm evaluates real
production data and is `OK` with a 0-valued datapoint.

What is still unproven: the alarm has not yet failed a real production rollout
(the drill account is the only place that happened), and no alarm email has
been confirmed in the inbox. The workflow verifies the alarm before it builds
or migrates, passes it to the stack, and fails the release if the service is not
watching it.

### Independent read-back, 2026-10-26 23:44–23:57 UTC

Account `556890483680`, `us-east-1`, caller
`arn:aws:iam::556890483680:user/blog`. This re-checked the deployed state after
the documentation above was written; it found no drift. Every check was a
read-only `Describe*`/`List*`/`Get*`/HTTP `GET`, except the `cdk diff` row: that
used CDK's read-only change set, which also publishes the template to the CDK
bootstrap bucket and creates then deletes a change set. No stack was executed
and no resource changed.

| Check | Observed |
| --- | --- |
| Stacks | `UniBudgetStack-Monitoring` `UPDATE_COMPLETE` 23:26:16Z; `UniBudgetStack` `UPDATE_COMPLETE` 23:27:18Z |
| Monitoring resources | 5 `AWS::CloudWatch::Alarm`, 2 `AWS::Logs::MetricFilter`, 1 `AWS::CDK::Metadata`; no ECS, ECR, IAM, log-group, or SNS resource |
| `Request5xx` | `UniBudget/Application` `Http5xxCount`, `Sum > 0`, 1 × 60 s, `notBreaching`, actions enabled, one SNS action; state `OK` with a real 0-valued datapoint |
| Other alarms | `Target5xx` 5 × 2 × 300 s, `UnhealthyTargets` Max > 0 × 2 × 60 s, `StructuredErrors` 5 × 2 × 300 s, `LiveTaskCount` Avg < 1 × 3 × 60 s; all `OK` |
| Metric filters | `{ $.status >= 500 }` → `Http5xxCount`; `{ $.level = "error" }` → `StructuredErrorCount`; both on `/unibudget/ecs/application` |
| ECS service | task definition `:4` (`v1.1.3`), desired 1 / running 1 / pending 0, rollout `COMPLETED`, target healthy |
| Running image | `sha256:168b26f5…0fa61c`, identical to the `v1.1.3` ECR manifest |
| Deployment monitoring | `alarms = [UniBudgetStack-Monitoring-Request5xx]`, `rollback: true`, `enable: true`; circuit breaker enabled, bounded 50% |
| Topic policy | one statement: `cloudwatch.amazonaws.com` may `sns:Publish` only when `aws:SourceArn` matches `arn:aws:cloudwatch:us-east-1:556890483680:alarm:UniBudgetStack-*`; no KMS key |
| Subscription | one confirmed email subscription; 0 pending, 0 deleted |
| Endpoints | `/` 200, `/api/health` 200 (`no-store`, `X-Request-Id`), `/api/live` 200, `/login` 200 (`X-Request-Id`), `/blog/first-post` 200 with the expected title, unknown slug 404 |
| Drift | `cdk diff UniBudgetStack-Monitoring` (same context values): "There were no differences" |

No production alarm has been in `ALARM` from metric data. `Request5xx` history
shows only `INSUFFICIENT_DATA → OK` at 23:27:26Z; the two production `ALARM`
states on record are the operator-set notification checks — `StructuredErrors`
at 2026-10-25T17:34:53Z and `UnhealthyTargets` at 2026-10-26T09:50:19Z.

## Release history and immutable tags

Release tags are never moved. A failed run does not create an ECR image, and
the next attempt uses the next patch version.

| Tag | Commit | Outcome |
| --- | --- | --- |
| `v1.1.0` | `1f7070f` | Deploy run failed at the test gate: the workflow had no PostgreSQL service or test database URL. No image was pushed. |
| `v1.1.1` | `0340df3` | Deploy run failed after 243 tests passed: the migration test teardown produced an unhandled `57P01`. No image was pushed. |
| `v1.1.2` | `d941721` | Deploy run failed at the CloudFront gate: the origin count expression counted the two keys of the `{Quantity, Items}` object. No image was pushed. |
| `v1.1.3` | `c9eb373` | **Released and verified in production.** |

The tags for the failed attempts remain in Git for audit. No `v1.1.0`,
`v1.1.1`, or `v1.1.2` image exists in ECR.

Three workflow defects were fixed before the successful release:

- PR #44 gave the deploy test job the same PostgreSQL service and test database
  URLs that CI already used.
- PR #45 tolerated only the expected `57P01` when `DROP DATABASE ... WITH
  (FORCE)` races a closing test socket after `pool.end()`; other pool errors
  still fail the suite.
- PR #46 read the CloudFront origin count and domain from `.Origins.Items`
  instead of indexing the `{Quantity, Items}` object.

## Recovery point

Supabase project `fkrtduyzpwfrbhooxvpr` (`unibudget-demo`) is on the Free Plan,
which provides **no scheduled backups and no point-in-time recovery**. The
release therefore used a verified manual recovery point:

| Item | Value |
| --- | --- |
| Reference | `s3://unibudget-db-backups-556890483680-us-east-1/supabase/fkrtduyzpwfrbhooxvpr/20261025T184503Z/unibudget-20261025T184503Z.dump` |
| Recovery-point timestamp | `2026-10-25T18:45:03Z` |
| Manifest | `.../20261025T184503Z/manifest.json` beside the dump |
| SHA-256 | `bf0fec9a783190fd4af43842f12cd5a2bdb41366e2ac989d25f4bbaa2d3e4722` |
| Restore verification | restored into a disposable PostgreSQL 17 container with the extensions schema and `uuid-ossp`/`pgcrypto`; 0 `pg_restore` errors; all seven public tables present with matching row counts |

This is a logical backup, not a Supabase-managed PITR point. It records the
schema and data at the timestamp above; it does not provide continuous
recovery. Recovering to a later point still requires a new manual dump.

The backup bucket was re-checked read-only on 2026-10-26: SSE-S3 (`AES256`),
versioning enabled, all public access blocked, and a 90-day expiry rule. The
full procedure, restore checks and approval requirements are in
[backup-and-recovery.md](backup-and-recovery.md). The Supabase plan itself was
not re-verified; treat the Free Plan statement as a 2026-10-25 record until it
is confirmed in the dashboard.

## Readiness matrix

| Area | Implemented | CI verified | Deployed | Verified in production |
| --- | --- | --- | --- | --- |
| Blog SSR route | yes | yes | yes (`v1.1.3`) | **200** for a real slug; **404** for an unknown slug |
| Liveness/readiness split | yes | yes | yes | `/api/live` 200; `/api/health` 200 |
| Deployment test gate | yes | yes | n/a | n/a |
| Post-deploy health/login/blog/404 checks | yes | yes | yes | passed in the release run |
| Image provenance labels and digest | yes | yes | yes | running digest equals ECR digest |
| Semantic and annotated tag enforcement | yes | yes | yes | `v1.1.3` on `c9eb373` |
| ECR retention preflight | yes | yes | applied out-of-band | preflight passed; four manifests retained |
| CloudWatch alarms + metric filter | yes | yes | **yes, separate stack** | five alarms and two filters present since 2026-10-26, all `OK` |
| ECS deployment alarm | yes | CDK + workflow contract tests | **yes** | `Request5xx` attached with `rollback: true`; the alarm has not yet failed a production rollout |
| SNS notification action | yes | CDK tests | **yes** | alarm history records successful actions (2026-10-25 `StructuredErrors`, 2026-10-26 `UnhealthyTargets`, both operator-set states); SNS counted 1 published / 1 delivered / 0 failed for the 2026-10-26 check; inbox receipt still not independently verified |
| Request correlation release gate | yes | yes (workflow contract + shell execution tests) | **no** — ships with the next release | `X-Request-Id` observed on the live `/login` response, 2026-10-26; the deployment gate itself has not run against production |
| Scheduled off-site backup | yes (workflow) | workflow contract tests | **yes — enabled, runs verified** | `BACKUP_DATABASE_URL` and `BACKUP_ENABLED=true` configured 2026-10-26; runs 40312355540 and 40313112911 stored both objects and matched their manifest checksums |
| Least-privilege deploy role | proposal only | no | no | role still has `AdministratorAccess` |
| CloudFront modern TLS | proposal only | no | no | minimum viewer TLS is `TLSv1` |
| Rollback Drill 2 | yes (runbook + fixes) | no | **drill account exercised; fixes deployed** | executed twice 2026-10-26; run 2 rolled back automatically. The same wiring is now live in production, where it has not yet been exercised |

## Remaining risks and open work

1. **CloudFront viewer TLS is `TLSv1`.** Raising it to `TLSv1.2_2021` requires
   a custom domain, an ACM certificate in `us-east-1`, DNS changes, and a
   separate approved change. See [cloudfront-tls-plan.md](cloudfront-tls-plan.md).
2. **The GitHub deploy role has `AdministratorAccess`.** The scoped policy in
   [iam-least-privilege.md](iam-least-privilege.md) is a proposal, not applied.
3. **The live ECR lifecycle policy was applied out-of-band and has not been
   reconciled by CloudFormation.** The next `cdk diff` will show a pending
   repository update until an approved stack deployment records it.
4. **The stale change set `unibudget-monitoring-20261025-1` no longer
   exists.** It was never executed, and a read-only check on 2026-10-26 lists no
   change sets for any production stack. Its historical risk was that it would
   recreate monitoring resources now owned by `UniBudgetStack-Monitoring` and
   make dynamic ECS, task-definition, and IAM changes.
5. **SNS inbox receipt is not independently proven, and no threshold crossing
   has occurred in production.** The notification chain is proven up to SNS:
   for the operator-set `UnhealthyTargets` check on 2026-10-26, alarm history
   has an `Action` item ("Successfully executed action"), SNS's hourly metrics
   for that window show 1 published, 1 delivered and 0 failed, and the topic
   policy admits only CloudWatch alarms under `UniBudgetStack-*`. None of that
   proves the message
   reached the mailbox rather than spam or quarantine, and every production
   `ALARM` state so far was set by an operator. A metric-driven crossing was
   observed only in the drill account on 2026-10-26, where no `Action` history
   item was captured.
6. **The deployment alarm is live but not yet exercised in production.**
   `Request5xx` is attached to the service with rollback enabled and evaluates
   real traffic, but the only failed rollout it has stopped was in the drill
   account on 2026-10-26. A future release that fails its readiness probe is
   the first production test of that path. See
   [rollback-drill-2.md](rollback-drill-2.md).
7. **Supabase has no managed backup or PITR on the Free Plan.** A manual dump
   and restore proof are required before each migration until the project is
   upgraded or a managed backup strategy is adopted. Provider documentation
   checked 2026-10-26 confirms free-tier projects receive neither daily backups
   nor PITR; the live plan itself was not re-checked. A scheduled off-site
   backup job now runs daily at 02:15 UTC and was verified against production
   on 2026-10-26; the RPO is still undecided, and the newest stored object is
   only as recent as the last successful run. See
   [backup-and-recovery.md](backup-and-recovery.md).
8. **The request-correlation gate is implemented but unreleased.** The current
   production image predates it, so a future release is the first run that can
   fail the deployment on a missing or malformed `X-Request-Id` header.

## Rollback

The previous application revision is
`UniBudgetStackApplicationTask3DB06674:3` (image `v1`). If `v1.1.3` must be
withdrawn, update the service back to that revision, wait for a stable service,
and re-check `/api/live`, `/api/health`, `/login`, the blog route, and the
running digest. The release adds no database migration, so the rollback is
schema-compatible; the legacy image will return **500** for `/blog/<slug>`
until the fix is redeployed.

The `v1.1.3` image and tag are immutable. Re-deploying after a rollback
requires a new patch tag (`v1.1.4`), not a moved tag.

## Operations performed for this release

- Created the encrypted logical backup and verified a restore into a
  disposable database.
- Created and pushed annotated tags `v1.1.0`, `v1.1.1`, `v1.1.2`, and
  `v1.1.3`; only `v1.1.3` produced an image.
- Dispatched four `Deploy` runs; the first three failed closed before any image
  push, migration, or deploy. The fourth built and pushed `v1.1.3`, ran the
  migration task, deployed task definition `:4`, and rolled out one healthy
  task.
- No IAM, DNS, certificate, CloudFront TLS, SNS, or monitoring resource was
  changed during the release. The stale change set was not executed.
