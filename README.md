# UniBudget

UniBudget is a server-rendered Astro application for managing transactions and
overall monthly budgets. It uses the Astro Node standalone adapter and
PostgreSQL for user, session, transaction, and budget data.

## Requirements

- Node.js 22.12 or newer
- npm
- PostgreSQL for local application use

## Local development

```powershell
npm ci
$env:DATABASE_URL = "postgresql://unibudget_app.PROJECT_REF:USER_PASSWORD@HOST:5432/postgres"
$env:MIGRATION_DATABASE_URL = "postgresql://postgres.PROJECT_REF:PASSWORD@HOST:5432/postgres"
$env:APP_DATABASE_PASSWORD = "USER_PASSWORD"
$env:PGSSLMODE = "verify-full"
$env:PGSSLROOTCERT = "./certs/supabase-ca.crt"
node scripts/migrate.mjs
npm run dev
```

The migration runner applies the numbered SQL files in `migrations/` and
provisions the `unibudget_app` role. It connects with
`MIGRATION_DATABASE_URL` (or the standard `PGHOST`, `PGUSER`, `PGPASSWORD`, and
`PGDATABASE` variables), never with the application's `DATABASE_URL`, and
requires verified TLS with a Supabase CA certificate. It records migration
checksums, refuses incompatible or drifted schemas, and removes Supabase Data
API role access from the UniBudget tables. Do not apply migrations to a
database containing existing application data without first reviewing its
schema and backing it up.

If the connection settings are stored in `.env`, load it explicitly because the
Node migration script does not read `.env` automatically:

```powershell
node --env-file=.env scripts/migrate.mjs
```

## Quality checks

```powershell
npm run check
npm run lint
npm test -- --run
npm run build
```

The PostgreSQL integration suites require a disposable `unibudget_test`
database on a local host or the CI PostgreSQL service; they skip when no test
database is configured and must never point at Supabase. See
[deployment guidance](./docs/deployment.md) for the exact variables.

The AWS CDK application is in `hello-cdk/`. Its build, tests, and synthesis
commands are documented in [deployment guidance](./docs/deployment.md).

## Production

The root [dockerfile](./dockerfile) builds and runs the Astro standalone Node
server. The production database is Supabase PostgreSQL through the session
pooler. The application requires `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`,
`PGPASSWORD`, `PGSSLMODE=verify-full`, and the Supabase CA certificate supplied
through `SUPABASE_CA_CERT`; the CDK tasks read those values from AWS Secrets
Manager. Never commit credentials, certificates, or `.env` files.

The application fails closed in production if it connects as a role other than
`unibudget_app`. `/api/health` performs a bounded `SELECT 1` and is the ALB
readiness probe; `/api/live` answers from the process alone and is the ECS
container liveness probe, so a database outage drains the target group
without replacing healthy tasks.

Deployment is manual through the OIDC-based GitHub Actions workflow described
in [deployment and migration guidance](./docs/deployment.md). The original RDS
resources remain in the CDK stack but are no longer used by the application;
they must not be removed without a verified snapshot and an approved cost
decision.

## Operations and release documentation

- [Release readiness and deployment gate](./docs/release-readiness.md)
- [CloudWatch alarms and operator triage](./docs/alarms.md)
- [Architecture decision records](./docs/adr/README.md)
- [IAM least-privilege assessment](./docs/iam-least-privilege.md)
- [Rollback Drill 2 runbook](./docs/rollback-drill-2.md)
- [Week 7 deliverables and evidence](./docs/week7-deliverables.md)

The current production image is `v1`, which predates the blog SSR fix; verify
`/blog/<slug>` after the next approved release. The readiness document lists
the remaining external blockers (ECR policy, alarm notifications, IAM scope,
release tag, and the unexecuted rollback drill).
