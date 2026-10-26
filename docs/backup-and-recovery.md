# Backup and recovery runbook

Status: **manual logical backups only**. Supabase does not provide managed
backups or point-in-time recovery for this project on the recorded plan, so the
recovery point is a dump taken and verified by an operator before a release.

This document records what is backed up, where it lives, how it is verified,
and what still requires a decision. It does not claim a recovery capability
that has not been exercised.

## 1. Provider position

| Item | Position | Evidence |
| --- | --- | --- |
| Supabase plan | Free Plan, recorded 2026-10-25 | [release-readiness.md](release-readiness.md#recovery-point) |
| Scheduled backups | **Not available on Free** | Provider docs, checked 2026-10-26: daily backups are taken for Pro, Team and Enterprise; free-tier projects are told to export with the CLI and keep off-site copies ([Database Backups](https://supabase.com/docs/guides/platform/backups)) |
| Point-in-time recovery | **Not available on Free** | Same docs: PITR is a Pro/Team/Enterprise add-on and requires at least a Small compute add-on |
| Plan re-checked during this revision | **No** | No authorised provider access from the repository environment; confirm the live plan in the dashboard before relying on the row above |

What a plan change would add, per the same provider documentation: daily
backups retained 7 days (Pro), 14 (Team) or 30 (Enterprise), and PITR as a paid
add-on with a 7-, 14- or 28-day recovery window (listed at roughly $100, $200
and $400 per month respectively). Upgrading is a cost and continuity decision
for the project owner; this repository does not make that change.

If the project is moved to a paid plan with backups or PITR, this runbook must
be revised before that capability is relied on. Do not assume the plan is
unchanged because this document says so.

## 2. What is backed up

One logical dump of the whole application database, including:

- the `public` schema and every table the application uses (`users`,
  `sessions`, `profiles`, `transactions`, `monthly_budgets`,
  `monthly_category_budgets_legacy`);
- the `schema_migrations` ledger, including each recorded checksum;
- the extension schema recorded in the dump (production uses `extensions`) and
  the `uuid-ossp` / `pgcrypto` extensions the migrations depend on;
- row data, primary keys, foreign keys and indexes.

Not covered by the dump: the ECR image, ECS task definitions, Secrets Manager
values, CloudWatch logs and the Supabase project configuration. Database
recovery never restores those; coordinate them separately.

## 3. Storage, retention and access

Verified read-only on 2026-10-26:

| Property | Value |
| --- | --- |
| Bucket | `unibudget-db-backups-556890483680-us-east-1` (us-east-1) |
| Prefix | `supabase/fkrtduyzpwfrbhooxvpr/<UTC timestamp>/` |
| Encryption at rest | SSE-S3 (`AES256`) |
| Versioning | Enabled |
| Public access | Fully blocked (`BlockPublicAcls`, `IgnorePublicAcls`, `BlockPublicPolicy`, `RestrictPublicBuckets`) |
| Lifecycle rule | `expire-manual-db-backups`, enabled, expires objects after 90 days |
| Existing point | `20261025T184503Z`: `manifest.json` (1,273 bytes) and `unibudget-20261025T184503Z.dump` (308,302 bytes) |

Access is limited to the AWS identities that can read that bucket; the bucket
is not public. Do not copy a dump to a laptop, chat, ticket or unencrypted
share. Reading the object requires the same authorised AWS identity used for
deployment operations.

The 90-day expiry is a lifecycle setting, not a recovery guarantee: a point
older than 90 days is gone. Take a fresh dump before each migration or release
that can change data.

## 4. Taking a backup

Run from a machine that can reach the database and assume the operator role.
Never put the connection string on the command line, in shell history, or in a
committed file; export it for the session only.

```bash
# $SUPABASE_DATABASE_URL is supplied by the operator environment, not the repo.
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
prefix="supabase/fkrtduyzpwfrbhooxvpr/${timestamp}"

pg_dump --format=custom --no-owner --no-privileges \
  --file="unibudget-${timestamp}.dump" "$SUPABASE_DATABASE_URL"
sha256sum "unibudget-${timestamp}.dump"
```

Write a `manifest.json` beside the dump containing at least: UTC timestamp,
source project reference, `pg_dump` version, SHA-256, byte size, and the
operator identity. Upload both objects under the prefix above, then verify the
uploaded object's checksum before discarding the local copy.

Do not commit the dump, the manifest, the connection string or the checksum
file. The repository ignores `*.dump`, `*.dump.gz` and `/backups/`.

## 4a. Automated schedule

`.github/workflows/backup-database.yml` performs the same logical dump on a
daily schedule (02:15 UTC) and on manual dispatch, then uploads the dump and
manifest under the project prefix above.

| Setting | Kind | Purpose |
| --- | --- | --- |
| `BACKUP_DATABASE_URL` | secret | Connection string used by `pg_dump`; never logged |
| `AWS_ACCOUNT_ID` | variable | Account the OIDC role must resolve to |
| `AWS_DEPLOY_ROLE_ARN` | variable | Existing deploy role, assumed with OIDC |
| `BACKUP_ENABLED` | variable | Set to `true` to let the schedule run; manual dispatch works without it |
| `AWS_REGION` | variable (optional) | Defaults to `us-east-1` |

The job validates the account, bucket encryption and bucket versioning before
dumping, rejects an archive `pg_restore` cannot list, compares the uploaded
object's SHA-256 with the local dump, and never prints the connection string.
It fails closed when the secret is absent.

Status: **implemented, not yet enabled**. No secret or `BACKUP_ENABLED`
variable is configured, so no scheduled backup has run. After enabling it,
confirm the first run produced both objects, then record the date and cadence
here.

## 5. Integrity verification

Before a restore:

1. Download the dump from S3 and compare `sha256sum` with the manifest.
2. Run `pg_restore --list` and confirm the schema, the six application tables
   and `schema_migrations` are present.
3. Confirm the manifest timestamp is the point you intend to recover to.

A dump that cannot be listed or whose checksum does not match is not a
recovery point. Take another one.

## 6. Restore into a disposable environment

Never restore over the live database. Use a throwaway PostgreSQL instance of
the same major version, with no production credentials mounted.

```bash
docker run --rm -d --name unibudget-restore-check \
  -e POSTGRES_PASSWORD=<test-only-password> \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1:55432:5432 postgres:17

# Create the target database and check which schema the dump expects.
psql "postgresql://postgres:<test-only-password>@127.0.0.1:55432/postgres" \
  -c 'CREATE DATABASE unibudget_restore;'
pg_restore --list "unibudget-<timestamp>.dump" \
  | grep -E 'SCHEMA|EXTENSION' | head -20

# If the dump references a non-default extension schema (production uses
# `extensions`), create that schema only. Do NOT pre-install the extensions in
# a different schema: pg_dump recreates each extension where it lived, and
# table defaults reference it explicitly. A 2026-10-26 rehearsal failed with
# "function public.uuid_generate_v4() does not exist" after uuid-ossp was
# pre-created in `extensions` while the dump expected `public`.
psql "postgresql://postgres:<test-only-password>@127.0.0.1:55432/unibudget_restore" \
  -c 'CREATE SCHEMA IF NOT EXISTS extensions;'   # only when the dump needs it

pg_restore --no-owner --no-privileges --exit-on-error \
  --dbname="postgresql://postgres:<test-only-password>@127.0.0.1:55432/unibudget_restore" \
  "unibudget-<timestamp>.dump"
```

`pg_restore --exit-on-error` must exit 0. Any error means the point is not
verified, even if some tables loaded.

## 7. Post-restore verification

Run every check; record the outputs with the restore evidence.

```sql
-- Schema and objects
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' ORDER BY 1;

-- Migration ledger: four applied migrations with 64-character checksums
SELECT name, checksum FROM public.schema_migrations ORDER BY name;

-- Row counts for the tables that carry user data
SELECT 'users', count(*) FROM public.users
UNION ALL SELECT 'sessions', count(*) FROM public.sessions
UNION ALL SELECT 'profiles', count(*) FROM public.profiles
UNION ALL SELECT 'transactions', count(*) FROM public.transactions
UNION ALL SELECT 'monthly_budgets', count(*) FROM public.monthly_budgets;

-- Authentication relationships: no orphaned session, profile or transaction
SELECT count(*) AS orphaned_sessions
  FROM public.sessions s LEFT JOIN public.users u ON u.id = s.user_id
 WHERE u.id IS NULL;
SELECT count(*) AS orphaned_profiles
  FROM public.profiles p LEFT JOIN public.users u ON u.id = p.user_id
 WHERE u.id IS NULL;
SELECT count(*) AS orphaned_transactions
  FROM public.transactions t LEFT JOIN public.users u ON u.id = t.user_id
 WHERE u.id IS NULL;
```

Also check the financial totals against the values recorded before the backup
(sum of `transactions.amount` grouped by `type`, and the monthly budget
amounts). A schema that loads with different totals is a failed restore.

## 8. Recovery objectives

No RPO or RTO has been agreed for this project. Do not quote these as
commitments:

| Objective | Status |
| --- | --- |
| RPO | **Decision required.** Practical exposure equals the time since the last manual dump; there is no continuous recovery |
| RTO | **Decision required and unmeasured.** The restore has been rehearsed into a disposable container, but no timed end-to-end restoration into production has been performed |

Proposed starting targets, to be confirmed or replaced by the project owner:
RPO of one release cycle (a fresh dump before every migration) and an RTO of
under two hours for a full restore plus application verification. These are
proposals, not current capability.

## 9. Approvals for a production restore

A production restore destroys data written after the recovery point. It
requires:

1. an incident or change record describing the data-loss window;
2. the project owner's explicit approval of the chosen point;
3. confirmation that the application revision deployed afterwards matches the
   restored schema;
4. a maintenance decision for traffic during the restore;
5. the same operator verifying the post-restore checks in section 7.

Never restore into production to "see whether it works". Prove the point in a
disposable environment first.

## 10. What is verified and what is not

| Claim | Status |
| --- | --- |
| Dump storage is encrypted, versioned, private and expires after 90 days | **Verified read-only, 2026-10-26** |
| A dump and manifest exist for `v1.1.3` | **Verified read-only, 2026-10-26** |
| That point was restored into a disposable PostgreSQL 17 instance with matching table counts | **Recorded 2026-10-25**; not re-performed during this revision |
| The dump/restore commands work end to end | **Rehearsed 2026-10-26 with synthetic data**: pg_dump custom format, `pg_restore --exit-on-error` returned 0, 7 public tables, 4 ledger rows, matching user/transaction/budget counts, 0 orphaned rows and an unchanged expense total. No production data was used |
| The production dump has been restored with these exact commands | **Not yet** — doing so would require the approved backup, which was not downloaded for this revision |
| Restore into the live project | **Not performed** |
| RPO/RTO | **Not agreed** |
| Current Supabase plan and backup settings | **Not re-verified** — requires dashboard access |

## 11. Related documents

- [release-readiness.md](release-readiness.md) — release history and the
  recorded `v1.1.3` recovery point.
- [chaos-drill.md](chaos-drill.md) — incident recovery sequence and the limits
  of application rollback.
- [deployment.md](deployment.md#existing-database-adoption-and-restore-points) —
  adoption and migration preconditions.
