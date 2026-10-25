# Architecture Decision Records

This directory records the decisions that shape UniBudget's runtime,
deployment, and operational model. Each record states what is actually
implemented; deployment or verification gaps are called out in the record
rather than implied.

Statuses:

- **Accepted** — the decision is implemented in the repository and is the
  intended operating model. It does not by itself mean the current production
  release contains it.
- **Proposed** — the decision is prepared but not applied, usually because it
  requires an external account, permission, or approval.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-astro-ssr-node-adapter.md) | Astro server rendering with the Node standalone adapter | Accepted |
| [0002](0002-supabase-postgresql.md) | Supabase PostgreSQL with a dedicated application role | Accepted |
| [0003](0003-docker-ecs-fargate.md) | Containerized ECS/Fargate runtime | Accepted |
| [0004](0004-cloudfront-private-alb.md) | CloudFront in front of a private ALB origin | Accepted |
| [0005](0005-liveness-and-readiness.md) | Separate liveness and readiness checks | Accepted |
| [0006](0006-rolling-deployment-and-rollback.md) | ECS rolling deployment with circuit-breaker rollback | Accepted |
| [0007](0007-cicd-migration-ordering.md) | Test-gated CI/CD with migration-before-rollout | Accepted |
| [0008](0008-immutable-images-and-semver.md) | Immutable ECR images, semantic releases, and provenance | Accepted |
| [0009](0009-cloudwatch-observability.md) | Structured logs, metric filter, and actionable alarms | Accepted |
| [0010](0010-github-oidc-least-privilege.md) | Least-privilege GitHub OIDC deployment role | **Proposed** |
| [0011](0011-https-and-custom-domain.md) | HTTPS on the CloudFront hostname; custom domain optional | Accepted |

The deployment runbook is in [../deployment.md](../deployment.md), and the
release-readiness checklist is in [../release-readiness.md](../release-readiness.md).
