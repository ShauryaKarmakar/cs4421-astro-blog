# 0010 — Least-privilege GitHub OIDC deployment role

- Status: **Proposed** — not applied; the current role and permissions were not
  inspected with sufficient IAM access to replace them safely.
- Date: 2026-10-25

## Context

The deployment workflow assumes an AWS role through GitHub OIDC. The role was
previously reported to have `AdministratorAccess`. That is a broad blast
radius for a workflow that builds one image and manages one stack, and it
makes the deployment identity a high-value target.

## Decision

Prepare, but do not apply, a scoped deployment role whose trust policy is
restricted to this repository, the intended branch/ref, and the `production`
GitHub environment. Replace `AdministratorAccess` with permissions grouped by
the operations the workflow actually performs:

- CloudFormation stack describe/create/update and stack-event/resource reads;
- ECR repository/image describes, authorization, lifecycle-policy read/write,
  and image push;
- ECS cluster/service/task describe, task definition register/deregister,
  run/stop task, and service update;
- ELB/EC2 resources created by the CDK stack, including the CloudFront
  origin-facing prefix-list read;
- CloudFront distribution/cache-policy/origin-request-policy management;
- CloudWatch alarms and Logs metric filters, plus log-group reads;
- Secrets Manager secret create/describe/tag (not `GetSecretValue` for the
  deploy role);
- IAM role create/update/attach and constrained `iam:PassRole` for the task
  roles and CDK bootstrap roles;
- S3/ECR permissions for CDK asset publication in the bootstrap account/region;
- SSM parameter read for the CDK bootstrap version.

Exact actions and resource ARNs must be derived from the actual CDK template,
CloudTrail history, and IAM Access Analyzer findings before the policy is
attached. `iam:PassRole` must be constrained to the specific roles and
`iam:PassedToService` values, not `*`.

## Alternatives considered

- **Keep `AdministratorAccess`** — rejected as the target state, even if it is
  the current state.
- **Long-lived access keys** — rejected; OIDC removes static credentials.
- **A hand-written policy from memory** — rejected because an incomplete
  policy could lock out deployments and an over-broad one recreates the
  problem.

## Consequences

- Until the role is scoped, the deployment identity remains a high-risk
  administrative credential.
- A migration must be staged: capture CloudTrail events for a full deployment,
  compare with Access Analyzer findings, attach the scoped policy in a
  non-production account first, and keep an approved rollback path to the
  existing policy.
- This decision is **not deployed or verified**. See
  [../iam-least-privilege.md](../iam-least-privilege.md) for the assessment and
  migration plan.
