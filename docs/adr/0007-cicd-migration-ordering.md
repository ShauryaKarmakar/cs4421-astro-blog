# 0007 — Test-gated CI/CD with migration-before-rollout

- Status: Accepted
- Date: 2026-10-25

## Context

A release can fail because the application tests fail, the image is wrong, a
migration fails, the database is unreachable, or the deployed route is broken.
Some steps are irreversible or externally visible, so ordering and evidence
matter more than a short pipeline.

## Decision

Use one deployment workflow, `.github/workflows/deploy.yml`, with the
`unibudget-production` concurrency lock and the `production` environment
approval. It enforces this order:

1. validate inputs, AWS identity, Supabase host, and recovery attestation;
2. install dependencies, run the application test suite, and build the CDK app;
3. verify CloudFront origin delivery and ECR retention policy;
4. build and push an immutable image, then record its digest;
5. verify the migration task definition and exact secret references;
6. run a one-off migration task and require exit code 0;
7. deploy the stack with the same image tag;
8. wait for ECS stability and verify the running image tag and digest;
9. verify `/api/health`, `/login`, a real blog slug, and an unknown slug 404.

A failing test or verification stops the run before the next irreversible
step. The mutation task never points the ECS service at the temporary
migration revision.

## Alternatives considered

- **Separate test, image, and deploy workflows** — rejected because a second
  deployment path can race the production lock, bypass migration ordering, or
  deploy an image that was never verified.
- **Background migration after rollout** — rejected because new code could
  observe a schema it does not support.
- **Skipping tests in deploy because CI already ran** — rejected because the
  deploy workflow can be dispatched from a branch or commit whose CI result is
  not part of the deployment evidence.

## Consequences

- Deployments are slower but have one auditable path and one image identity.
- The workflow needs a valid recovery point attestation before it deploys; it
  refuses to run at all when the stack does not exist, so creating a stack is a
  separate, manual operation.
- Post-deployment route checks can fail a release after the stack update; the
  circuit breaker and the previous task definition remain the recovery path.
- The workflow cannot verify restorability itself; the recovery reference and
  timestamp are explicit operator attestations.
