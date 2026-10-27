# IAM least privilege for the GitHub deployment role

Status: **proposal only — not applied.** `unibudget-github-deploy` still has
`AdministratorAccess` attached. No IAM permission, trust relationship, or
resource was changed, and nothing in this document reduces the role's current
access.

**Why it has not been applied.** The policy's permissions have not been
validated against all three deployment workflows. The audit is read-only
(CloudTrail, IAM reads, Access Analyzer), and the evidence cannot close the
gap on its own: CloudTrail records only the runs that happened (`deploy.yml` on
2026-10-25, `deploy-static.yml` and `backup-database.yml` on 2026-10-26), S3
data events are not logged, and `iam:PassRole` produces no event at all. A
permission missing from those logs is therefore indistinguishable from one that
simply has not been exercised. Attaching the document to the production role
would stake releases on an unproven policy.

**Validation is deferred as a future security task**, not completed here. It
requires a dedicated staging account; none exists today. The rollback-drill
account was approved for one short session, was torn down afterwards, and holds
no bootstrap, OIDC trust, stacks, buckets, or distributions, so it cannot run
the workflows as they stand. Standing one up is a separate, approved change.
The prerequisites and the ordered procedure are in
[iam-staging-validation-plan.md](iam-staging-validation-plan.md).

**Outstanding risk: `AdministratorAccess` remains attached.** Until the staging
validation passes and a production cutover is separately approved, the GitHub
deployment role keeps account-wide permissions, and a compromise of any of the
three workflows still reaches the whole account. This is tracked as an open
risk in [release-readiness.md](release-readiness.md#remaining-risks-and-open-work),
not as a resolved item. Reviewed 2026-10-27 against the live role, the three
workflows that assume it, and CloudTrail. Implementation needs a separate
approval.

## 1. Verified current state

Read-only `aws iam` calls on 2026-10-27 (account `556890483680`, `us-east-1`):

| Property | Observed value |
| --- | --- |
| Role | `arn:aws:iam::556890483680:role/unibudget-github-deploy` |
| Attached policy | `AdministratorAccess` (`arn:aws:iam::aws:policy/AdministratorAccess`) |
| Inline policies | none |
| Created | 2026-10-24T21:42:58Z |
| Last used | 2026-10-26T11:11:37Z |
| Max session | 3600 s |
| Trust action | `sts:AssumeRoleWithWebIdentity` |
| Trust condition | `aud = sts.amazonaws.com`; `sub = repo:ShauryaKarmakar@109453869/cs4421-astro-blog@1362714459:environment:production` |

The trust policy is scoped to this repository and the `production` GitHub
environment, but the attached policy is account-wide. One identity serves three
workflows, distinguished only by session name:

| Workflow | Session name | CloudTrail evidence |
| --- | --- | --- |
| `.github/workflows/deploy.yml` | `unibudget-deploy` | 131 events, 2026-10-25 18:00–21:00Z |
| `.github/workflows/deploy-static.yml` | `unibudget-static-deploy` | 12 events, 2026-10-26 09:40–09:41Z (`GetDistribution`, `CreateInvalidation`, `GetInvalidation`, `GetBucketLocation`) |
| `.github/workflows/backup-database.yml` | `unibudget-database-backup` | 12 events, 2026-10-26 10:30–11:30Z |

## 2. What the role actually does

### 2.1 AWS calls made by the GitHub role itself

From the workflow source and CloudTrail, aggregated over the deploy run and the
backup run:

| Area | Actions (observed unless marked) | Resource observed |
| --- | --- | --- |
| STS | `GetCallerIdentity`, `AssumeRole` | three CDK bootstrap roles (below) |
| CloudFormation | `DescribeStacks` (38 calls) | `UniBudgetStack` |
| CloudWatch | `DescribeAlarms` (required by the current workflow; not present in the recorded 2026-10-24/25 runs) | `UniBudgetStack-Monitoring-*` |
| EC2 | `DescribeManagedPrefixLists` | account-wide read |
| ECR | `GetAuthorizationToken`, `BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage`, `DescribeImages`, `GetLifecyclePolicy` | the one application repository |
| ECS | `DescribeClusters`, `DescribeServices`, `DescribeTaskDefinition`, `RegisterTaskDefinition`, `DeregisterTaskDefinition`, `DescribeTasks`, `ListTasks`, `RunTask`, `StopTask` | the one cluster, service, and migration task family |
| CloudFront | `GetDistribution`, `GetDistributionConfig` | the SSR distribution |
| S3 (static) | `GetBucketLocation`, `ListObjectsV2`, `PutObject` | static site bucket only |
| S3 (backup) | `GetBucketEncryption`, `GetBucketVersioning`, `PutObject`, `GetObject` | backup bucket only |
| Secrets Manager | `GetSecretValue` | `unibudget/supabase/ca` only |
| KMS | `Decrypt` | AWS-managed `aws/secretsmanager` key `3fcb1e83-…` |
| CloudFront (static) | `GetDistribution`, `CreateInvalidation`, `GetInvalidation` | static distribution |

`iam:PassRole` does not appear in CloudTrail (it is an authorization check, not
an event), but `ecs:RunTask` and `ecs:RegisterTaskDefinition` for the migration
family require it for that task's role and execution role. That is inferred
from the API contract and must be verified in the staged test. The current
migration definition has no tags (`tags: null`), so registration does not need
`ecs:TagResource`; if tags are added to the stack later, registration will
require it and this policy must be extended.

Reproduction (read-only):

```bash
aws cloudtrail lookup-events \
  --start-time 2026-10-24T00:00:00Z --end-time 2026-10-27T00:00:00Z \
  --lookup-attributes AttributeKey=Username,AttributeValue=unibudget-deploy
# Repeat with unibudget-database-backup, and filter EventName=CreateInvalidation
# for unibudget-static-deploy. Parse CloudTrailEvent.userIdentity.arn; the
# top-level Username field is not the assumed-role ARN.
```

### 2.2 What `cdk deploy` does through assumed roles

The GitHub role never updates the stack directly. It assumes three
CDK bootstrap roles; the deploy role in turn drives CloudFormation, which uses
its own execution role for the resource changes:

| Assumed role | Observed activity |
| --- | --- |
| `cdk-hnb659fds-deploy-role-556890483680-us-east-1` | `CreateChangeSet`, `ExecuteChangeSet`, `DescribeStacks/Events`, `GetTemplate`, `ssm:GetParameter`, `kms:Decrypt` |
| `cdk-hnb659fds-file-publishing-role-556890483680-us-east-1` | asset uploads (not visible as S3 data events in CloudTrail) |
| `cdk-hnb659fds-lookup-role-556890483680-us-east-1` | environment lookups |
| `cdk-hnb659fds-cfn-exec-role-556890483680-us-east-1` | the actual resource changes: ECR, ECS, ELBv2, IAM, CloudFront, Logs, RDS reads, Secrets Manager read |

**Consequence:** scoping only the GitHub role removes account-wide direct
actions (creating IAM users, reading unrelated buckets, changing unrelated
stacks), but a compromise can still assume the bootstrap deploy role and run
CloudFormation with the execution role's permissions. Real least privilege needs
both layers; §5 phases them.

## 3. Proposed scoped policy (review copy)

Attach this to `unibudget-github-deploy` **only after** the staged test in §6.
It replaces `AdministratorAccess`; do not keep both attached.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CallerIdentity",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "AssumeCdkBootstrapRoles",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": [
        "arn:aws:iam::556890483680:role/cdk-hnb659fds-deploy-role-556890483680-us-east-1",
        "arn:aws:iam::556890483680:role/cdk-hnb659fds-file-publishing-role-556890483680-us-east-1",
        "arn:aws:iam::556890483680:role/cdk-hnb659fds-lookup-role-556890483680-us-east-1"
      ]
    },
    {
      "Sid": "ReadApplicationStack",
      "Effect": "Allow",
      "Action": "cloudformation:DescribeStacks",
      "Resource": "arn:aws:cloudformation:us-east-1:556890483680:stack/UniBudgetStack/*"
    },
    {
      "Sid": "ReadDeploymentAlarm",
      "Effect": "Allow",
      "Action": "cloudwatch:DescribeAlarms",
      "Resource": "arn:aws:cloudwatch:us-east-1:556890483680:alarm:UniBudgetStack-Monitoring-*"
    },
    {
      "Sid": "ReadPrefixLists",
      "Effect": "Allow",
      "Action": "ec2:DescribeManagedPrefixLists",
      "Resource": "*"
    },
    {
      "Sid": "EcrAuthToken",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "PushApplicationImage",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:DescribeImages",
        "ecr:GetLifecyclePolicy"
      ],
      "Resource": "arn:aws:ecr:us-east-1:556890483680:repository/unibudgetstack-applicationrepository13e54097-nb3o4t9o4cok"
    },
    {
      "Sid": "DescribeEcsCluster",
      "Effect": "Allow",
      "Action": ["ecs:DescribeClusters", "ecs:ListTasks"],
      "Resource": "arn:aws:ecs:us-east-1:556890483680:cluster/UniBudgetStack-ApplicationClusterC783CD56-hXQUSkONBCXV"
    },
    {
      "Sid": "DescribeEcsService",
      "Effect": "Allow",
      "Action": "ecs:DescribeServices",
      "Resource": "arn:aws:ecs:us-east-1:556890483680:service/UniBudgetStack-ApplicationClusterC783CD56-hXQUSkONBCXV/UniBudgetStack-ApplicationService423C69C6-YCFTDtV8bRhX"
    },
    {
      "Sid": "DescribeAndStopMigrationTasks",
      "Effect": "Allow",
      "Action": ["ecs:DescribeTasks", "ecs:StopTask"],
      "Resource": "arn:aws:ecs:us-east-1:556890483680:task/UniBudgetStack-ApplicationClusterC783CD56-hXQUSkONBCXV/*"
    },
    {
      "Sid": "DescribeTaskDefinitions",
      "Effect": "Allow",
      "Action": "ecs:DescribeTaskDefinition",
      "Resource": [
        "arn:aws:ecs:us-east-1:556890483680:task-definition/UniBudgetStackApplicationTask3DB06674:*",
        "arn:aws:ecs:us-east-1:556890483680:task-definition/UniBudgetStackMigrationTaskDDB416C8:*"
      ]
    },
    {
      "Sid": "ManageTemporaryMigrationTaskDefinition",
      "Effect": "Allow",
      "Action": [
        "ecs:RegisterTaskDefinition",
        "ecs:DeregisterTaskDefinition",
        "ecs:RunTask"
      ],
      "Resource": "arn:aws:ecs:us-east-1:556890483680:task-definition/UniBudgetStackMigrationTaskDDB416C8:*"
    },
    {
      "Sid": "PassMigrationTaskRoles",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::556890483680:role/UniBudgetStack-MigrationTaskTaskRole*",
        "arn:aws:iam::556890483680:role/UniBudgetStack-MigrationTaskExecutionRole*"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "ecs-tasks.amazonaws.com"
        }
      }
    },
    {
      "Sid": "ReadApplicationDistribution",
      "Effect": "Allow",
      "Action": ["cloudfront:GetDistribution", "cloudfront:GetDistributionConfig"],
      "Resource": "arn:aws:cloudfront::556890483680:distribution/E30KFH719MS9Z0"
    },
    {
      "Sid": "PublishStaticSite",
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": "arn:aws:s3:::staticsitestack-sitebucket397a1860-33rkrycbsdvl"
    },
    {
      "Sid": "PublishStaticObjects",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::staticsitestack-sitebucket397a1860-33rkrycbsdvl/*"
    },
    {
      "Sid": "InvalidateStaticSite",
      "Effect": "Allow",
      "Action": [
        "cloudfront:GetDistribution",
        "cloudfront:GetInvalidation",
        "cloudfront:CreateInvalidation"
      ],
      "Resource": "arn:aws:cloudfront::556890483680:distribution/E2JVO3G1WG2Q2T"
    },
    {
      "Sid": "BackupBucketChecks",
      "Effect": "Allow",
      "Action": ["s3:GetEncryptionConfiguration", "s3:GetBucketVersioning"],
      "Resource": "arn:aws:s3:::unibudget-db-backups-556890483680-us-east-1"
    },
    {
      "Sid": "BackupObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::unibudget-db-backups-556890483680-us-east-1/*"
    },
    {
      "Sid": "ReadBackupCa",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:us-east-1:556890483680:secret:unibudget/supabase/ca-*"
    },
    {
      "Sid": "DecryptSecretsManagerData",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:us-east-1:556890483680:key/3fcb1e83-feff-4cc9-af65-69e0cf59924f",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "secretsmanager.us-east-1.amazonaws.com"
        }
      }
    }
  ]
}
```

The minified document is 4,377 characters, under the 6,144-character managed
policy limit. `iam:SimulateCustomPolicy` rejects inputs over 2,000 characters,
so the whole document was not run through that API; the JSON was parsed, and
`aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY` returned no
findings on 2026-10-27. Neither check proves resource scoping; the staged test
in §6 is the authoritative check. Chunked simulations can be run per statement
if a reviewer wants a pre-attachment check.

Deliberately absent: `iam:*` (other than the constrained `PassRole`),
`cloudformation:Create*/Update*/Delete*`, `ecr:PutLifecyclePolicy`,
`secretsmanager:GetSecretValue` outside the CA secret, S3 access outside the two
named buckets, and any `ec2:*` or `cloudfront:*` write outside the static-site
invalidation.

## 4. Why the role names look unstable

Several resources carry CDK-generated suffixes
(`unibudgetstack-applicationrepository13e54097-nb3o4t9o4cok`,
`UniBudgetStack-MigrationTaskTaskRole9CC4695E-TzeMqheIdgQH`). If a stack
replacement recreates them, the policy must be updated in the same change.
The `UniBudgetStack-MigrationTask*` wildcard covers the two task roles across
replacement; the ECR repository and cluster names are stable because the stack
retains them. Re-run the read-back in §6.7 after any replacement.

## 5. Two-phase implementation

**Phase 1 (the policy above).** Keep one role for the three workflows. This
removes account-wide capability and blocks the obvious escalation paths, but
the CDK bootstrap deploy/execution roles still allow broad stack changes.

**Phase 2 (bootstrap scoping).** Give the CFN execution role a stack-scoped
policy via `cdk bootstrap --cloudformation-execution-policies`. This is a
bootstrap-stack update, needs its own review, and must be tested against a full
deploy and rollback before production. Phase 2 is the long-term answer; Phase 1
is the safe first reduction.

**Phase 3 (role split, optional).** Split deploy, static, and backup into three
roles with separate GitHub environments, so the backup identity cannot push
images and the deploy identity cannot read the CA secret. This needs three
OIDC subjects and three repository variables; not required for Phase 1.

## 6. Test plan (staging first; no production permission change until it passes)

> **Not yet run. This is a future security task.** Its prerequisites (a
> designated staging account with CDK bootstrap, GitHub OIDC trust, the two
> stacks, the static stack, the backup bucket, and a separate Supabase project)
> do not exist. The staged, evidence-producing version of this plan, with
> pass/fail criteria, durations, and the tests that cannot run in the available
> account, is in
> [iam-staging-validation-plan.md](iam-staging-validation-plan.md). Do not
> attach this policy to production on the strength of the steps below alone.

### 6.0 Prerequisites

- A non-production AWS account with CDK bootstrap identical to production
  (`CDKToolkit` and the same qualifier), plus the staging stack and static stack.
- A copy of the policy with staging ARNs substituted; staging bucket and
  distribution IDs.
- The workflow pointed at a copy of the production workflow on a test branch,
  using a staging OIDC subject. Do not point a test at production resources.

### 6.1 Positive: full deployment

1. Attach the scoped policy to a **new** staging role (same trust, staging
   subject). Do not detach `AdministratorAccess` from the production role yet.
2. Run the full Deploy workflow against staging: tests, build, ECR push,
   migration task, `cdk deploy`, post-deploy alarm check, route checks.
3. Acceptance: workflow succeeds; zero `AccessDenied` in CloudTrail for that
   session; CloudFormation stack reaches `UPDATE_COMPLETE`; the running digest
   matches the pushed digest; `/api/health`, `/login`, and the blog route pass.

### 6.2 Positive: no-op deployment

Repeat the same dispatch with no code change. This exercises `cdk diff`,
change-set creation with no changes, and the `DescribeStacks` path, which a
first deploy can mask.

### 6.3 Positive: failure and rollback path

Deploy a staging-only image whose `/api/health` returns 500 (the Rollback
Drill 2 method, never to production). Acceptance: `Request5xx` fires,
`deployment failed: alarm detected`, ECS rolls back, and the scoped role
records no permission errors while the alarm and rollback are observed.

### 6.4 Positive: static site and backup

Run `deploy-static.yml` and `backup-database.yml` against staging. Acceptance:
the static upload succeeds using the object-write permission (no broader S3
access), invalidation completes, the backup object and manifest are written,
the read-back checksum matches, and no permission beyond the policy is
requested.

### 6.5 Negative: forbidden actions

Evaluate the denied actions without invoking them, using an admin identity
(not the role under test) and `iam:simulate-principal-policy`. Each line pairs
the action with its real target ARN in the staging account:

```bash
while IFS='|' read -r action resource; do
  printf '%s: ' "$action"
  aws iam simulate-principal-policy \
    --policy-source-arn "arn:aws:iam::<staging-account>:role/<staging-role>" \
    --action-names "$action" \
    --resource-arns "$resource" \
    --query 'EvaluationResults[0].EvalDecision' --output text
done <<'EOF'
iam:CreateUser|arn:aws:iam::<staging-account>:user/least-privilege-probe
cloudformation:DeleteStack|arn:aws:cloudformation:us-east-1:<staging-account>:stack/UniBudgetStack/*
cloudformation:UpdateStack|arn:aws:cloudformation:us-east-1:<staging-account>:stack/UniBudgetStack/*
ec2:RunInstances|arn:aws:ec2:us-east-1:<staging-account>:instance/*
ecr:PutLifecyclePolicy|arn:aws:ecr:us-east-1:<staging-account>:repository/unibudgetstack-applicationrepository13e54097-nb3o4t9o4cok
secretsmanager:GetSecretValue|arn:aws:secretsmanager:us-east-1:<staging-account>:secret:unibudget/supabase/application-*
s3:PutObject|arn:aws:s3:::some-other-bucket/*
EOF
```

Expected result: `implicitDeny` or `explicitDeny` on every line. Then confirm
two harmless live denials with the staging role itself: `aws cloudformation
describe-stacks --stack-name CDKToolkit` and `aws secretsmanager
get-secret-value --secret-id unibudget/supabase/application`. Never use a
destructive command (delete/update stack, run-instances) as a permission probe;
a wrong policy would perform it.

Also confirm the role cannot assume any role other than the three CDK bootstrap
roles, and that `iam:PassRole` fails for the application task role.

### 6.6 Production cutover

1. Attach the production policy first; leave `AdministratorAccess` attached.
2. Detach `AdministratorAccess` in the same change window; verify the role with
   `aws iam list-attached-role-policies`.
3. Run one normal release and the static deploy; watch for `AccessDenied` in
   the workflow log and CloudTrail.
4. Keep a human break-glass admin identity, not the deploy role, able to
   reattach `AdministratorAccess` if the release fails on a missing permission.
   Do not grant the role `iam:AttachRolePolicy` to make rollback "self-service".
5. Rollback of the IAM change is reattaching `AdministratorAccess`; it is
   deliberately not available to the role itself.

### 6.7 Evidence to record

Workflow run IDs, CloudTrail `AccessDenied` counts (expected 0 in positives,
expected 1 per negative), the attached-policy read-back, and the successful
release digest. Store them with the release record; do not claim least privilege
from the policy text alone.

## 7. Known gaps before any attachment

- **`AdministratorAccess` is still attached, and this proposal does not change
  that.** The role's live permissions are unchanged until the staging validation
  passes and a separate production cutover is approved; treat the current
  account-wide access as an outstanding risk, not a mitigated one.
- **Bootstrap roles remain broad.** Phase 1 does not constrain what
  `cdk-hnb659fds-cfn-exec-role` can change. Phase 2 is required for a complete
  answer.
- **Data events are not in CloudTrail.** S3 object actions are derived from the
  workflow source, not observed events; the staged test is what confirms them.
- **`iam:PassRole` is inferred**, not observed; §6.5 tests it.
- **First-deploy/bootstrap actions are not covered.** The role is for recurring
  deploys; bootstrapping a new account stays a human, reviewed operation.
- **Resource names can change on stack replacement.** Re-read the ARNs in §3
  before attaching after a replacement.
- **One role, three jobs.** Until Phase 3, backup can read the CA secret and the
  deploy workflow can write static objects. That is a smaller blast radius than
  `AdministratorAccess` but not the final state.

No policy was attached or detached for this proposal, and no AWS permission
changed.
