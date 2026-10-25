# 0002 — Supabase PostgreSQL with a dedicated application role

- Status: Accepted
- Date: 2026-10-25

## Context

UniBudget stores users, sessions, transactions, and overall monthly budgets.
Each row belongs to one user, and the deployment previously used an RDS
instance that is retained in the stack but no longer serves the application.
The application needs managed PostgreSQL, verified TLS, and a migration path
that does not grant the runtime administrative access.

## Decision

Use Supabase PostgreSQL through its session pooler on port 5432.
The application connects as `unibudget_app`; migrations connect separately
with the migration credentials and create/upgrade the schema. The ECS task
receives `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and
`PGSSLROOTCERT`/`SUPABASE_CA_CERT`; it must not use a `DATABASE_URL` override.
TLS is `verify-full` with the Supabase CA certificate.

Every user-owned query is scoped by the authenticated user ID derived from the
session, never by a user ID supplied in the request body or query string.
The migration runner removes Supabase Data API role access from UniBudget
tables.

## Alternatives considered

- **Retained RDS instance** — already provisioned but no longer used; a cost
  and ownership decision, not a runtime choice.
- **Direct PostgreSQL connection without a pooler** — rejected for this
  project because the session pooler is the supported Supabase connection
  path and the deployment already manages its host/CA configuration.
- **Application-level admin role** — rejected because it would remove the
  privilege boundary between runtime and migrations.

## Consequences

- The database is a required dependency for authenticated application routes;
  `/api/health` must report readiness failure when it is unavailable.
- Database credentials and the CA certificate live in Secrets Manager, never in
  the image or repository.
- Migrations are forward-only and must run before a rollout; recovery requires
  a verified Supabase backup or PITR restore point.
- Per-user isolation depends on every query using the session-derived user ID;
  tests and code review must catch unscoped queries.
