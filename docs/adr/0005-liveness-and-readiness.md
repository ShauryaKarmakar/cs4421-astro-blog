# 0005 — Separate liveness and readiness checks

- Status: Accepted
- Date: 2026-10-25

## Context

The application depends on PostgreSQL. If the ECS container health check also
depended on the database, a database outage would make ECS replace healthy
application tasks, adding churn and losing in-flight work without fixing the
dependency. Conversely, routing traffic to a task that cannot query the
database would serve errors.

## Decision

Use two endpoints with distinct contracts:

- `/api/live` is process liveness only. It returns `200 {"status":"ok"}` from
  the process and never queries PostgreSQL. The ECS container health check uses
  it.
- `/api/health` is readiness. It verifies the application role and performs a
  bounded `SELECT 1`; it returns `503 {"status":"unavailable"}` on failure
  without exposing the database error. The ALB target group uses it.

The auth middleware exempts both paths so the role gate cannot replace their
payloads with a generic 503. Exemptions are exact path matches, not prefixes.

## Alternatives considered

- **One database-dependent health endpoint for both checks** — rejected
  because a database outage would trigger unnecessary task replacement.
- **One process-only endpoint for both checks** — rejected because the ALB
  would keep routing to a task that cannot serve data routes.
- **No container health check** — rejected because a hung Node process would
  remain in service.

## Consequences

- During a database outage, all targets become unhealthy and the service has
  no ready capacity; tasks remain alive and recover when the database returns.
- A task can be alive but not ready. Operators must distinguish ECS task state
  from ALB target health.
- The readiness query has a two-second server-side timeout and a 2.5-second
  client timeout; it cannot hang a health check indefinitely.
- The health payload is deliberately minimal and does not disclose connection
  details.
