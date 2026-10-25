# 0006 — ECS rolling deployment with circuit-breaker rollback

- Status: Accepted
- Date: 2026-10-25

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
- A failed rollout is detected by target health and the deployment circuit
  breaker, which restores the last completed task definition automatically.
- A successful `services-stable` is not sufficient evidence: the workflow also
  verifies the running image tag and digest.
- Rollback restores the previous task definition; it does not reverse a
  database migration. Migration recovery uses the verified Supabase restore
  point.
