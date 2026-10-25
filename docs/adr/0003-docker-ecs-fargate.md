# 0003 — Containerized ECS/Fargate runtime

- Status: Accepted
- Date: 2026-10-25

## Context

UniBudget needs a repeatable production artifact, a process-level liveness
check, and a runtime that can be replaced without managing EC2 hosts. The CDK
stack already defines a VPC, an ALB, CloudWatch logging, and ECS resources.

## Decision

Build a multi-stage `node:24-bookworm-slim` image. The build stage installs
dependencies and runs `npm run build`; the runtime stage contains only the
compiled server, production dependencies, migrations, and the two runtime
scripts. The container runs as the non-root `node` user on port 8080.

Run the image on ECS/Fargate with 256 CPU units and 512 MiB, a task execution
role for ECR/Secrets Manager/CloudWatch, and a separate task role for
application access. The ECS container health check probes `/api/live`; the ALB
target group probes `/api/health`.

## Alternatives considered

- **EC2 with a process manager** — rejected because it adds host patching and
  capacity management without a project need.
- **AWS App Runner or Lambda** — possible, but would replace the existing ALB,
  VPC, and ECS architecture and its deployment controls.
- **A single-stage image with dev dependencies** — rejected because it
  increases the runtime attack surface and image size.

## Consequences

- The image is immutable and must be rebuilt for every code or dependency
  change.
- The runtime has no shell-based diagnostic tooling; operational diagnosis uses
  CloudWatch logs and ECS task metadata.
- Fargate task replacement is safe only when liveness is independent of the
  database; readiness gates traffic separately.
- Secrets are injected at runtime and are never baked into the image.
