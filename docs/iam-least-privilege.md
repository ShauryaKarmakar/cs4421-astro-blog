# IAM least privilege for the GitHub deployment role

Status: **assessment and proposal only**. No IAM policy was attached, detached,
or edited.

## Verified current state

Read-only `aws iam` calls on 2026-10-25 found the deployment role used by the
workflow:

| Property | Observed value |
| --- | --- |
| Role | `unibudget-github-deploy` |
| Attached policy | `AdministratorAccess` (`arn:aws:iam::aws:policy/AdministratorAccess`) |
| Inline policies | none |
| Trust action | `sts:AssumeRoleWithWebIdentity` |
| Audience condition | `token.actions.githubusercontent.com:aud = sts.amazonaws.com` |
| Subject condition | `repo:ShauryaKarmakar@109453869/cs4421-astro-blog@1362714459:environment:production` |

The trust policy is already scoped to this repository and the `production`
GitHub environment. It does not include a `ref:refs/heads/...` condition, so
the environment's branch protection is the remaining branch restriction. The
`AdministratorAccess` attachment is a real, verified over-permission. A
re-check after PR #40 merged on 2026-10-25 still returned exactly that one
attached policy and no inline policies; merging code did not change IAM.

## Why this is a risk

The workflow can build an image, create and update the entire stack, and read
or modify anything else in the account if the role is compromised or a
workflow change is malicious. A deployment identity should be able to change
only the resources required for this stack.

## Permission inventory

This is an inventory, not a finished policy. Exact actions and ARNs must be
derived from a full deployment's CloudTrail events and IAM Access Analyzer
findings before any policy is attached.

| Area | Likely required operations | Evidence |
| --- | --- | --- |
| OIDC | `sts:AssumeRoleWithWebIdentity` with repo/environment conditions | verified trust policy |
| CloudFormation | describe stacks/events/resources, create/update stack | inferred from `cdk deploy` |
| ECR | authorization, repository/image describe, push, lifecycle-policy get/put, scan configuration | inferred from build/push and policy |
| ECS | cluster/service/task describe, task-definition register/deregister, run/stop task, service update | inferred from migration and deploy |
| ELBv2 | load balancer/target group/listener create and describe, target health | inferred from CDK stack |
| EC2/VPC | VPC, subnet, route, security-group, prefix-list read/create | inferred from CDK stack |
| CloudFront | distribution and cache/origin-request-policy create/update/describe | inferred from CDK stack |
| CloudWatch Logs | log group create/describe/retention, metric filter put/describe | inferred from observability resources |
| CloudWatch | alarm put/describe/delete, alarm actions | inferred from alarms |
| Secrets Manager | secret create/describe/tag; **not** `GetSecretValue` for the deploy role | inferred from empty secrets and task execution roles |
| IAM | role create/update/attach, constrained `iam:PassRole` | inferred from task roles and CDK bootstrap |
| S3/SSM | CDK asset bucket access, bootstrap version parameter read | inferred from CDK bootstrap |
| SNS | attach an existing topic only; no create/subscribe | optional alarm action |

Do not grant `iam:PassRole` on `*`. Constrain it to the UniBudget task roles
and the CDK bootstrap roles, and add `iam:PassedToService` conditions.

## Migration plan

1. Capture CloudTrail events for one complete non-production deployment,
   including a migration, an alarm update, and an ECR lifecycle-policy update.
2. Run IAM Access Analyzer policy generation for the role's CloudTrail trail.
3. Convert the generated policy into a reviewed template with explicit resource
   ARNs and a constrained `iam:PassRole`.
4. Test it in a non-production account with the same CDK bootstrap and stack.
5. Keep the existing `AdministratorAccess` attachment available as a rollback
   path until a full deployment and rollback drill succeed under the scoped
   policy.
6. Attach the scoped policy, remove `AdministratorAccess`, and verify both a
   normal deployment and the failure/rollback path.

## What is not verified

- The complete set of actions the CDK bootstrap roles require.
- Whether the deployment role needs `s3:PutObject`/`s3:GetObject` on the CDK
  asset bucket or can use the bootstrap roles.
- Whether any hidden dependency requires `iam:CreateServiceLinkedRole`.
- The exact policy that would avoid locking out the next deployment.

These gaps are why this document proposes a staged migration rather than an
untested policy replacement. The current role remains administrative and is a
release blocker for a fully hardened deployment.
