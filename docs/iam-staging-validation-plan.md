# IAM least-privilege — staging validation plan

Status: **future security task — not started; blocked on prerequisites.** No
eligible staging account exists. Nothing was applied.

Prepared 2026-10-27 with read-only calls only: `sts`, `iam`, `s3api`, `ecr`,
`ecs`, `cloudfront`, `secretsmanager`, `kms`, `cloudformation`, `ssm`,
`resourcegroupstaggingapi`. No IAM policy was attached, detached, or edited; no
trust relationship changed; no AWS resource created or deleted; no workflow
dispatched; no GitHub variable, environment, or secret changed; nothing staged
or committed.

The proposal itself is [iam-least-privilege.md](iam-least-privilege.md) §3, and it
remains a proposal: `unibudget-github-deploy` still carries `AdministratorAccess`.
This document does not change that policy or that risk. It records whether the
policy can be validated, why it cannot yet, and what must exist first, so the
validation can be picked up later as its own approved task.

## 1. Repository state

Reviewed against `main` at `db6392f5` (the merge of PR #55), level with
`origin/main` at the time of the review. The readiness facts in this plan come
from the read-only AWS calls listed above; the branch position is recorded only
so a later run can tell whether the policy or the workflows have moved since.

Files in the worktree that this review did not own were left untouched. The IAM
review found no inconsistency between the proposal and the live workflow source,
so the stop condition in the task brief was not triggered; the
permission-coverage questions it did find are listed in §3.2.

## 2. Staging-account eligibility: **not eligible**

### 2.1 What exists

Two accounts are reachable from this machine, distinguished by profile:

| Profile | Account | Identity | Region |
| --- | --- | --- | --- |
| `default` | `556890483680` | production deployment identity (AdministratorAccess) | `us-east-1` |
| `drill` | `293633790894` | `arn:aws:iam::293633790894:user/drill`, AdministratorAccess | `us-east-1` |

`293633790894` is the rollback-drill account recorded in
[rollback-drill-2.md](rollback-drill-2.md) ("approved for one short session") and
in `drill-evidence*/cleanup-results.txt`. It is **not** designated as a staging
account anywhere in the repository, and it is not in an AWS Organization
(`AWSOrganizationsNotInUseException`), so nothing constrains it to a
non-production role.

Read-only inventory of `293633790894` on 2026-10-27:

| Capability the test needs | Present? |
| --- | --- |
| GitHub OIDC provider (`token.actions.githubusercontent.com`) | **No** — `OpenIDConnectProviderList` is empty |
| `unibudget-github-deploy` or any `unibudget*` role | **No** — only six `AWSServiceRoleFor*` roles |
| CDK bootstrap roles (`cdk-hnb659fds-*`) | **No** |
| `CDKToolkit` stack | **Deleted** — `DELETE_COMPLETE`; `/cdk-bootstrap/hnb659fds/version` returns `ParameterNotFound` |
| `UniBudgetStack`, `UniBudgetStack-Monitoring` | **Deleted** — both `DELETE_COMPLETE` (two drill runs) |
| Application ECR repository | **No** — no repositories |
| Static-site bucket, backup bucket, CDK assets bucket | **No** — no buckets at all |
| ECS cluster | **No active cluster** — two `INACTIVE` remnants from the drill |
| CloudFront distribution (static or SSR) | **No** |
| Secrets Manager secrets (CA, application, migration) | **No** |
| Customer-managed KMS key | **No** — only AWS-managed aliases |
| RDS / DynamoDB data | **None** |
| Supabase project reachable with staging credentials | **No** — none configured |

The account holds no data that must be preserved; the only remnants are the two
`INACTIVE` ECS clusters and the account's payment instrument. "Empty" is not the
same as "designated", and the task explicitly forbids inferring disposability
from non-production status. It is also missing every prerequisite: bootstrap,
OIDC trust, the two stacks, the static stack, the backup bucket, and a separate
Supabase project.

Two further blockers are independent of which account is chosen:

1. **The workflows cannot be pointed at staging without editing them.**
   `deploy-static.yml` hard-codes `STATIC_BUCKET`,
   `STATIC_DISTRIBUTION_ID`, `STATIC_SITE_HOST`, and `SSR_DISTRIBUTION_ID`, and
   fails if the live resources do not match; `backup-database.yml` hard-codes
   `BACKUP_BUCKET` and `SUPABASE_PROJECT_REF`; `deploy.yml` derives the account
   and region from repository variables and deploys the fixed stack name
   `UniBudgetStack`. All three assume `environment: production`. A staging run
   therefore needs copies of the three workflows with substituted constants and
   their own environment — which is a repository change plus a GitHub
   configuration change, both outside this task's authority.
2. **The staging identity has to be a new role**, per
   [iam-least-privilege.md](iam-least-privilege.md) §6.0. Creating it, its trust
   policy, and the OIDC provider are resource changes.

### 2.2 Prerequisites before the plan in §4 can run

| # | Prerequisite | Why it is required | Owner |
| --- | --- | --- | --- |
| P1 | Explicit written designation of the staging account (either `293633790894` or a new third account), with a named owner and a teardown date | "Not production" does not make an account disposable; `293633790894` was approved for one drill session only | Account owner |
| P2 | A staging-bound profile plus an operator preflight asserting that `sts get-caller-identity` returns the staging account and never `556890483680` | The current `drill` profile is a long-lived IAM **user** with AdministratorAccess; a typo in `--profile` targets production | Operator |
| P3 | `cdk bootstrap aws://<staging>/us-east-1` with qualifier `hnb659fds` (creates `CDKToolkit`, five `cdk-*` roles, assets bucket, container-assets repo) | The proposal's test plan assumes the same three bootstrap roles; a full deploy needs the bootstrap SSM parameter | Approved change window |
| P4 | Staging `UniBudgetStack`, `UniBudgetStack-Monitoring`, static stack (S3 + CloudFront), and the backup bucket (SSE, versioning) | The workflows' preflight checks fail closed on missing stack, alarm, bucket, or distribution | Approved change window |
| P5 | A **separate** Supabase project with staging CA, application, and migration secrets, and a staging `BACKUP_DATABASE_URL` | Production secrets must never be used for a staging positive or negative test | Operator |
| P6 | GitHub OIDC provider in the staging account and a **new** staging role whose trust is scoped to a staging subject (never the production environment) | The role under test must be assumable only by the staging workflow | IAM change |
| P7 | Staging copies of the three workflows on a test branch, with staging constants substituted and an account-assertion guard in each job; a GitHub `staging` environment with its own variables | The production workflows hard-code production identifiers and `environment: production` | Repository change (separate approval) |
| P8 | A staging copy of the policy from [iam-least-privilege.md](iam-least-privilege.md) §3 with the staging account ID, bootstrap role ARNs, generated resource names, bucket names, distribution IDs, secret suffix, and the staging KMS key substituted | Copying production ARNs would grant nothing in staging and would test the wrong document | Derived after P3–P4 |

P8 cannot be completed from the current information: the generated names only
exist after P3–P4, and the staging KMS key ID and secret suffix are account
specific.

## 3. Policy audit against the live source

Every ARN in the proposal was checked against the live production account, so
the comparison below is policy-versus-reality rather than policy-versus-doc.

### 3.1 ARNs verified correct in production

| Proposal element | Live value | Match |
| --- | --- | --- |
| ECR repository | `unibudgetstack-applicationrepository13e54097-nb3o4t9o4cok` | yes |
| ECS cluster | `UniBudgetStack-ApplicationClusterC783CD56-hXQUSkONBCXV` | yes |
| Migration task family | `UniBudgetStackMigrationTaskDDB416C8` | yes |
| Migration task role | `UniBudgetStack-MigrationTaskTaskRole9CC4695E-TzeMqheIdgQH` | matched by `UniBudgetStack-MigrationTask*` |
| Migration execution role | `UniBudgetStack-MigrationTaskExecutionRoleC8275516-8SAKn7PjIptU` | matched by `UniBudgetStack-MigrationTask*` |
| Application task family | `UniBudgetStackApplicationTask3DB06674` | yes |
| Deployment alarm | `UniBudgetStack-Monitoring-Request5xx` | matched by `UniBudgetStack-Monitoring-*` (all five live alarms match) |
| Static distribution | `E2JVO3G1WG2Q2T` → `d2eip6kpluaijf.cloudfront.net`, `Deployed` | yes |
| SSR distribution | `E30KFH719MS9Z0` → `d3jsso3b2vz1cp.cloudfront.net`, `Deployed` | yes |
| Static bucket | `staticsitestack-sitebucket397a1860-33rkrycbsdvl` (us-east-1) | yes |
| Backup bucket | `unibudget-db-backups-556890483680-us-east-1` (SSE AES256, versioning enabled) | yes |
| CA secret | `unibudget/supabase/ca-NdGD2K` | matched by `…/ca-*` |
| KMS key | `3fcb1e83-feff-4cc9-af65-69e0cf59924f` — `KeyManager: AWS`, "Default key that protects my Secrets Manager data…", `Enabled`; the CA secret uses the default key (`KmsKeyId: null`) | yes |
| Bootstrap roles | `cdk-hnb659fds-{deploy,file-publishing,lookup,image-publishing,cfn-exec}-role-556890483680-us-east-1` | three proposed are present |

### 3.2 Coverage findings

**F1 — `cloudwatch:DescribeAlarms` stays.** It is required by
`deploy.yml`'s "Verify the Deployment Alarm Before Rolling Out" step and absent
from the 2026-10-24/25 CloudTrail sessions because the step post-dates them. The
policy must keep it; removing it would break the release at the pre-flight. It is
granted on `alarm:UniBudgetStack-Monitoring-*`, and the workflow always passes
`--alarm-names`, which is the only form that can be resource-scoped. **Untested:**
whether the scoped ARN is sufficient for `DescribeAlarms` — confirm in T2/T3; a
name outside the wildcard should fail closed rather than return an empty list.

**F2 — `iam:PassRole` is inferred, not observed.** `iam:PassRole` does not
produce a CloudTrail event. The scope
(`UniBudgetStack-MigrationTask*`, `iam:PassedToService = ecs-tasks.amazonaws.com`)
matches the live migration task and execution roles exactly, and the workflow
passes only those two when registering the temporary revision. The application
task role is deliberately not passable. Untested until T4.

**F3 — `ecs:TagResource` is correctly absent *today*.** The live migration
revision reports `tags: null`, so `RegisterTaskDefinition` does not tag. If tags
are ever added in CDK, registration will be denied and the policy must be
extended in the same change. This is a standing tripwire, not a defect.

**F4 — `s3:GetBucketLocation` is granted only for the static bucket.** The
backup workflow copies with `aws s3 cp`, which may resolve the bucket region
before `PutObject`. If it does, the backup fails with `AccessDenied` on
`s3:GetBucketLocation` for the backup bucket. **Untested**; T6 decides whether to
add it. Do not add it pre-emptively — a staging denial is the evidence.

**F5 — image-publishing role is not needed by this app.** `cdk-stack.ts` uses
`ecs.ContainerImage.fromEcrRepository` with no `DockerImageAsset`/`fromAsset`, so
CI builds and pushes with its own credentials. The proposal's three-role
`sts:AssumeRole` set is correct. If a container asset is ever introduced, the
fourth role must be allowed or `cdk deploy` fails at synth/asset upload.

**F6 — `cloudformation:DescribeStacks` scope is sufficient.** The workflow's
pre-flight uses the bare stack name `UniBudgetStack`, whose ARN matches
`stack/UniBudgetStack/*`. `CDKToolkit` is read by the bootstrap deploy role, not
by the GitHub role, so it is correctly not granted.

**F7 — CloudFront actions match one-for-one.** `GetDistribution` and
`GetDistributionConfig` on the SSR distribution; `GetDistribution`,
`GetInvalidation`, `CreateInvalidation` on the static distribution. No
`ListDistributions`, no distribution write, no cache-policy read. Nothing extra
is requested by the workflows.

**F8 — `kms:Decrypt` is pinned to an AWS-managed key.** The ARN and the
`ViaService` condition are correct for production, but that key is
account-and-region specific and cannot be reused: staging needs its own
`aws/secretsmanager` key ID after the CA secret is created. If the secret is ever
re-encrypted with a customer-managed key, the pinned ARN becomes stale and the
backup fails.

**F9 — ECR push set is complete for a docker push.** `BatchCheckLayerAvailability`,
`InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage`,
`DescribeImages`, `GetLifecyclePolicy`, plus `GetAuthorizationToken` on `*`
(which cannot be resource-scoped). No pull permission is needed because CI never
pulls.

**F10 — two `Describe*` grants are account-wide by API design.**
`ec2:DescribeManagedPrefixLists` and `ecr:GetAuthorizationToken` do not support
resource-level scoping. They are read-only and already minimal.

**Scope gaps acknowledged by the proposal and still open:** bootstrap execution
role remains broad (Phase 2); S3 data events are absent from CloudTrail, so
object-level permission is source-derived; first-deploy/bootstrap actions are
out of scope; CDK-generated names change on stack replacement.

## 4. Staging test procedure

Each test states its objective pass criterion. Run them in order; a failure at
T1–T3 stops the sequence. All AWS commands run under the staging profile **and**
the account guard from P2; none may target `556890483680`.

Total expected wall-clock: **2 h 15 min** including teardown, excluding the
provisioning in P3–P7 (~1 h, separate change window). Cost is carried by the
staging account: ECS Fargate tasks, one ALB, one CloudFront distribution, S3
storage, and a CloudWatch alarm.

| # | Test | Duration | Pass criterion | Evidence |
| --- | --- | --- | --- | --- |
| T1 | Attach the substituted policy (P8) to the new staging role as an inline policy named `unibudget-staging-least-privilege`; leave any pre-existing staging policy untouched | 5 min | `list-role-policies` shows the policy; `get-role-policy` read-back is byte-identical to the reviewed document; `accessanalyzer validate-policy` returns no findings | Policy JSON hash, read-back, account ID |
| T2 | Full staging deployment through the staging copy of `deploy.yml` (tests, build, ECR push, migration, `cdk deploy`, alarm check, health/blog/404 checks) | 30–40 min | Workflow `success`; zero `AccessDenied`/`UnauthorizedOperation` for the role session in CloudTrail; stack `UPDATE_COMPLETE`; running task digest equals the pushed digest; `/api/health`, `/login`, one `/blog/:slug` 200 and an unknown slug 404 through CloudFront | Run ID, CloudTrail denial count (0), digest, HTTP codes |
| T3 | No-op redeploy of the same image tag with no code change | 15–20 min | `success`; change set is empty; `DescribeStacks`/`DescribeAlarms` paths exercised again; still zero denials | Run ID, change-set status |
| T4 | Migration task execution and secret access | 5–10 min | Temporary revision registers against `UniBudgetStackMigrationTask*`, task reaches `STOPPED` with exit code 0, revision deregisters, no `iam:PassRole` or `ecs:RegisterTaskDefinition` denial; Secrets Manager read is limited to the CA secret | Task ARN, stop reason, exit code, denial count (0) |
| T5 | Static-site deployment through the staging copy of `deploy-static.yml` | 10 min | Upload succeeds without delete or ACL calls; invalidation reaches `Completed`; live verification script passes; the SSR distribution is never referenced | Run ID, invalidation ID, object count |
| T6 | Database-backup run through the staging copy of `backup-database.yml` | 10 min | Dump uploaded, manifest written, read-back SHA-256 matches; if `s3:GetBucketLocation` is denied here, record it as the F4 determination and extend the policy, then repeat | Run ID, checksum, denial event if any |
| T7 | Alarm-triggered ECS rollback using a staging-only `/api/health` → 500 image | 25–30 min | `Request5xx` goes `OK → ALARM`; ECS reports `deployment failed: alarm detected`; service returns to the previous task definition; the role records no permission errors while the alarm and rollback are observed | Alarm history, ECS events, previous task-definition ARN |
| T8 | Negative checks: `iam:simulate-principal-policy` from an admin identity for `iam:CreateUser`, `cloudformation:DeleteStack`/`UpdateStack` on `UniBudgetStack`, `ec2:RunInstances`, `ecr:PutLifecyclePolicy`, `secretsmanager:GetSecretValue` on `…/application-*`, `s3:PutObject` on an unlisted bucket, and `sts:AssumeRole` on the application task role and on `cdk-hnb659fds-image-publishing-role` | 10 min | Every line `implicitDeny`/`explicitDeny`; two harmless live denials confirmed with the role itself (`describe-stacks --stack-name CDKToolkit` and `get-secret-value --secret-id …/application`); no destructive call ever used as a probe | Simulation output, the two live denial events |
| T9 | CloudTrail review of the staging sessions | 15 min | Allowed actions are a subset of §3 plus the three bootstrap role assumptions; denied actions are exactly T8's two; no action against the monitoring stack, another distribution, the CDK assets bucket, or any unlisted bucket | Filtered event export, counts per event name |
| T10 | Recovery | 5 min | Remove the inline policy; restore the role's previous attachment set exactly as recorded in T1's pre-change read-back; `get-role`/`list-attached-role-policies` match the snapshot | Before/after snapshots |

### 4.1 Tests that cannot run in the available account

T1–T10 all require P1–P8. In the current state none can run: there is no staging
role to attach to, no bootstrap roles to assume, no stack, no bucket, no
distribution, no alarm, and no OIDC trust. The two CloudFront distributions,
the buckets, the secret, and the KMS key that the policy names exist only in
production, so every positive test would have to run against production — which
this task forbids and which would invalidate the result anyway.

What *can* be done before the prerequisites exist is the document-level check
already recorded in [iam-least-privilege.md](iam-least-privilege.md) §3:
`accessanalyzer validate-policy`, plus per-statement
`iam:simulate-custom-policy` (2,048-character limit per input) against placeholder
ARNs. That proves the JSON parses and the statements deny by default; it proves
nothing about resource scoping. The staging run is the authoritative check.

## 5. Rollback and recovery

**Policy rollback (T10).** The staging role is new, so recovery is deletion, not
restoration:

```bash
# Recorded before T1: aws iam list-attached-role-policies, list-role-policies,
# get-role-policy for each inline policy, and get-role's AssumeRolePolicyDocument.
aws iam delete-role-policy \
  --role-name <staging-role> \
  --policy-name unibudget-staging-least-privilege
# Then re-attach anything the pre-change snapshot shows was attached before.
```

If the staging role was created for this test and nothing else uses it, delete
the role after detaching, but keep the OIDC provider and bootstrap roles — they
are shared prerequisites, not part of the test.

**If a positive test fails on `AccessDenied`.** Do not widen the policy first.
Capture the exact event (`eventName`, `errorCode`, `requestParameters`,
`userIdentity.sessionContext.sessionIssuer.arn`) and decide whether the action is
one the workflow genuinely performs. Only then add the narrowest statement that
covers the observed ARN, re-run the failed test, and update §3 and the proposal
in the same change. Re-running with a broader policy than the one under review
invalidates the test.

**Failure isolation.** Because the staging role is separate and the staging
account has no production data, a failed test leaves production untouched. If
the staging account were ever to share the production Supabase project or
backup bucket, stop — the test is no longer safe.

**Production is unchanged.** `unibudget-github-deploy` still carries
`AdministratorAccess` and its trust policy is unchanged; nothing in this plan
alters it. The production cutover in
[iam-least-privilege.md](iam-least-privilege.md) §6.6 remains gated on a passing
T1–T10 record.

## 6. Open questions for approval

1. **Which account?** Designate `293633790894` (empty, already billed, but
   currently reached by a long-lived AdministratorAccess IAM user and with no
   OIDC provider) as the standing staging account, or provision a third account?
   The task's read-only constraint means either choice needs an approved
   provisioning window.
2. **Who creates P3–P7?** Bootstrapping, the two stacks, the static stack, the
   backup bucket, the OIDC provider, and the staging workflows are all creations
   or repository changes that this task excludes. Is a single approved window
   acceptable, or should bootstrap be a separate change?
3. **Staging data.** Confirm a separate Supabase project (required) and whether
   the backup test may dump from it, or should use a disposable Postgres.
4. **Workflow copies.** May the staging validation live as copies of the three
   workflows on a test branch with substituted constants, leaving `main`'s
   workflows untouched? Editing the production workflows to branch on account
   would weaken the hard-coded identifier guards that exist specifically to stop
   cross-account mistakes.
5. **Phase 2 in scope?** Scoping `cdk-hnb659fds-cfn-exec-role` with
   `--cloudformation-execution-policies` should be validated in the same staging
   window, since it changes the same blast radius. Without it, a compromised
   deploy identity can still drive arbitrary stack changes through the bootstrap
   deploy role.
6. **Cost window.** How long may the staging stack run? ECS, ALB, CloudFront, and
   CloudWatch alarms bill continuously; §4 assumes a single day.

## 7. Unverified

- Whether `cloudwatch:DescribeAlarms` is satisfied by the alarm-ARN scope
  (F1).
- Whether `iam:PassRole`'s condition and scope cover the temporary migration
  revision (F2).
- Whether `aws s3 cp` to the backup bucket requires `s3:GetBucketLocation`
  there (F4).
- Whether any workflow action falls outside the policy because it only appears
  on a path not yet exercised in staging (first deploy after a stack
  replacement, a failed migration cleanup, a cancelled run).
- The staging resource names, distribution IDs, bucket names, secret suffix,
  and KMS key ID — they do not exist yet (P8).
- The effectiveness of Phase 2; the bootstrap execution role is still broad.

No AWS permission, resource, deployment, workflow, secret, or application file
was changed in preparing this plan.
