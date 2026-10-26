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
| CloudWatch alarms | four deployed in `UniBudgetStack-Monitoring`, all `OK` |
| SNS topic | `unibudget-production-alarms`, one confirmed email subscription |
| CloudFront | `E30KFH719MS9Z0`, `Deployed`, HTTPS redirect, one ALB origin, cache disabled, viewer TLS `TLSv1` |
| ECR images | four manifests: `v1.1.3`, `v1`, and two untagged |
| ECR retention | tagged `*`/10 and untagged/10; preflight passed before the push |
| Rollback Drill 2 | not executed |

The run built and pushed the immutable image, completed the one-off migration
task, deployed the stack, waited for a stable service, verified the running
digest, and passed the post-deploy `/api/health`, `/login`, real blog slug, and
unknown-slug 404 checks through CloudFront. The read-back above was performed
separately after the run.

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
| CloudWatch alarms + metric filter | yes | yes | **yes, separate stack** | four alarms present, all `OK` |
| SNS notification action | yes | CDK tests | **yes** | alarm history records a successful action; SNS reported one delivered and zero failed notifications for the 2026-10-26 test publish; inbox receipt still not independently verified |
| Request correlation release gate | yes | yes (workflow contract + shell execution tests) | **no** — ships with the next release | `X-Request-Id` observed on the live `/login` response, 2026-10-26; the deployment gate itself has not run against production |
| Scheduled off-site backup | yes (workflow) | workflow contract tests | **yes — enabled, runs verified** | `BACKUP_DATABASE_URL` and `BACKUP_ENABLED=true` configured 2026-10-26; runs 40312355540 and 40313112911 stored both objects and matched their manifest checksums |
| Least-privilege deploy role | proposal only | no | no | role still has `AdministratorAccess` |
| CloudFront modern TLS | proposal only | no | no | minimum viewer TLS is `TLSv1` |
| Rollback Drill 2 | runbook only | no | no | not executed |

## Remaining risks and open work

1. **CloudFront viewer TLS is `TLSv1`.** Raising it to `TLSv1.2_2021` requires
   a custom domain, an ACM certificate in `us-east-1`, DNS changes, and a
   separate approved change. See [cloudfront-tls-plan.md](cloudfront-tls-plan.md).
2. **The GitHub deploy role has `AdministratorAccess`.** The scoped policy in
   [iam-least-privilege.md](iam-least-privilege.md) is a proposal, not applied.
3. **The live ECR lifecycle policy was applied out-of-band and has not been
   reconciled by CloudFormation.** The next `cdk diff` will show a pending
   repository update until an approved stack deployment records it.
4. **The stale change set `unibudget-monitoring-20261025-1` is still
   `AVAILABLE`.** It must not be executed: it would recreate monitoring
   resources now owned by `UniBudgetStack-Monitoring` and can make dynamic ECS,
   task-definition, and IAM changes.
5. **SNS inbox receipt is not independently proven, and no real threshold
   crossing has occurred.** Alarm history proves CloudWatch executed the
   publish action, and SNS reported one successful delivery for the controlled
   2026-10-26 publish; neither proves the message reached the mailbox rather
   than spam or quarantine.
6. **Rollback Drill 2 has not been executed.** The rollback path is documented
   and its workflow contracts are tested, but no drill has observed a real
   circuit-breaker rollback. See [rollback-drill-2.md](rollback-drill-2.md).
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
