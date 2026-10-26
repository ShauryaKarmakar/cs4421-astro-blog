# 0006 — ECS rolling deployment with circuit-breaker rollback

- Status: Accepted
- Date: 2026-10-25
- Deployment status (2026-10-26): implemented and verified end to end in the
disposable drill account. **Not yet applied to the production stack** — the
production service still runs without a deployment alarm until the monitoring
stack and then the application stack are deployed.

## Context

The project needs zero-downtime releases, a bounded blast radius, and a
rollback path that does not require rebuilding an image. The ECS service is
small (one to ten tasks) and the ALB performs readiness checks against
`/api/health`.

## Decision

Use the ECS rolling deployment controller with:

- `minHealthyPercent: 100` and `maxHealthyPercent: 200`;
- the ALB target group gating traffic on `/api/health`;
- `circuitBreaker: { rollback: true }`;
- the `Request5xx` CloudWatch alarm attached as an ECS **deployment alarm**
  (`ROLLBACK_ON_ALARM`), passed by name from the separate monitoring stack;
- immutable ECR tags, so the previous task definition remains a known image;
- CloudFront caching disabled, so no edge purge is needed after a task change.

This is **not** Blue/Green. There is one target group, one ECS service, and no
second production environment or traffic switch.

## Alternatives considered

- **Recreate** — simpler but introduces downtime.
- **Blue/Green** — faster traffic-level rollback, but requires a second target
  group, CodeDeploy/ECS deployment groups, listener switching, extra alarms,
  and additional cost and operational complexity. It is not required by the
  current architecture.
- **Canary** — needs traffic shaping or weighted target groups and a stable
  measurement period; not justified for this project size.

## Consequences

- Old and new task versions can coexist briefly during a rollout; both must
  tolerate the current database schema. This is why migrations are backward
  compatible and run before the new tasks.
- A failed rollout is detected by target health and, decisively, by the
  deployment alarm, which restores the last completed task definition
  automatically. Verified on 2026-10-26: a broken readiness endpoint took the
  alarm to `ALARM` 33 s after the first failed probe and ECS rolled back with no
  operator action (`docs/rollback-drill-2.md` §8).
- The circuit breaker is **not** the primary mechanism on this service size.
  ECS clamps its bounded-percent threshold to a minimum of three failed tasks
  and the service runs one task, so the breaker needs three failed launches
  before it acts. At the observed cadence (one failed launch every ~eight
  minutes) that is a rollout of roughly 25 minutes, which is why run 1 did not
  roll back automatically and the operator did it by hand. The breaker stays
  enabled for restart behaviour and as an independent second line of defence;
  its threshold scales with the desired count, so it becomes proportionally
  faster as the service grows.
- A successful `services-stable` is not sufficient evidence: the workflow also
  verifies the running image tag and digest.
- Rollback restores the previous task definition; it does not reverse a
  database migration. Migration recovery uses the verified Supabase restore
  point.
