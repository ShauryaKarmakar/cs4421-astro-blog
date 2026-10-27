# ECR lifecycle policy — reconciliation record

Status: **no reconciliation deployment is needed. The live policy, the deployed
CloudFormation template, and the CDK definition agree.** Verified read-only on
2026-10-27; nothing was deployed, previewed, or changed.

## 1. What is compared

| Source | How it was read |
| --- | --- |
| Live repository | `aws ecr get-lifecycle-policy --repository-name unibudgetstack-applicationrepository13e54097-nb3o4t9o4cok` |
| Deployed stack template | `aws cloudformation get-template --stack-name UniBudgetStack`, `AWS::ECR::Repository.Properties.LifecyclePolicy.LifecyclePolicyText` |
| CDK definition | `hello-cdk/lib/cdk-stack.ts`, `ApplicationRepository.lifecycleRules` |
| Preflight | `scripts/ecrLifecyclePolicy.mjs`, run by the Deploy workflow before the image build |

Repository ARN:
`arn:aws:ecr:us-east-1:556890483680:repository/unibudgetstack-applicationrepository13e54097-nb3o4t9o4cok`.
Tag mutability `IMMUTABLE`, scan-on-push `true`.

## 2. Observation

All three sources describe the same two rules:

| Priority | Tag status | Selection | Count | Action |
| --- | --- | --- | --- | --- |
| 1 | `tagged` with `tagPatternList: ["*"]` | `imageCountMoreThan` | 10 | `expire` |
| 2 | `untagged` | `imageCountMoreThan` | 10 | `expire` |

The exact live text:

```json
{"rules":[{"rulePriority":1,"description":"Retain the ten most recent tagged releases as rollback candidates.","selection":{"tagStatus":"tagged","tagPatternList":["*"],"countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}},{"rulePriority":2,"description":"Expire untagged manifests and attestations no longer referenced by a tagged release.","selection":{"tagStatus":"untagged","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}
```

The deployed template's `LifecyclePolicyText` parses to an object **equal** to
the live policy (checked field-by-field, including priorities, descriptions,
selections, and actions). The CDK rules produce those same two selections; the
CDK test `retains tagged releases separately from untagged manifests` asserts
the rule list and rejects a `tagStatus: "any"` rule.

Live read-back at the time of the original check (2026-10-26): `lastEvaluatedAt`
2026-10-26T11:17:41Z. ECR re-evaluates the policy on its own schedule, so that
timestamp advances and is not a stable identifier; it records when the policy
was last evaluated, not the state compared here. At that check the repository
held four manifests: `v1.1.3`, `v1`, and two untagged (platform manifest and
BuildKit attestation), so the tagged rule retains the rollback candidate and
the untagged rule has room for the next push.

## 3. Why the older documents said otherwise

The policy was originally applied through the ECR API on 2026-10-25 (not through
CloudFormation). The release-readiness, deployment, Week 7, `hello-cdk/README`,
and monitoring-plan notes were written before the next stack deployment and
therefore said the template still held the old `any`/5 policy.

CloudTrail shows the missing step happened:

| Time (UTC) | Event | Actor |
| --- | --- | --- |
| 2026-10-24T22:19:59Z | `PutLifecyclePolicy` | `cdk-hnb659fds-cfn-exec-role-…/AWSCloudFormation` |
| 2026-10-24T22:44:02Z | `PutLifecyclePolicy` | same |
| 2026-10-24T22:49:13Z | `PutLifecyclePolicy` | same |
| 2026-10-25T15:20:59Z | `PutLifecyclePolicy` | `arn:aws:iam::556890483680:user/blog` (the out-of-band apply) |
| 2026-10-25T19:37:13Z | `PutLifecyclePolicy` | `cdk-hnb659fds-cfn-exec-role-…/AWSCloudFormation` (the v1.1.3 stack update) |

The 2026-10-25 19:37:13Z event is the one that recorded the approved policy in
the deployed template. The later 2026-10-26 23:27 update changed only the ECS
deployment alarm, so it did not touch ECR.

## 4. Minimal reconciliation

**Documentation only. No stack update, no `put-lifecycle-policy`, no deploy.**

1. Correct the stale "pending repository update" notes to point at this record.
2. Keep the workflow preflight (`node scripts/ecrLifecyclePolicy.mjs -`) where
   it is: it refuses an unsafe policy before a build, independent of the
   template.
3. If a future reviewer wants a stack-level confirmation, run a read-only
   `cdk diff UniBudgetStack` with the live context values and confirm the ECR
   repository shows no change. Do not execute a change set for this purpose;
   the template and live policy already match.

Verification commands (read-only):

```bash
aws ecr get-lifecycle-policy \
  --repository-name unibudgetstack-applicationrepository13e54097-nb3o4t9o4cok \
  --query lifecyclePolicyText --output text | node scripts/ecrLifecyclePolicy.mjs -

aws cloudformation get-template --stack-name UniBudgetStack \
  --query 'Resources.ApplicationRepository13E54097.Properties.LifecyclePolicy.LifecyclePolicyText' \
  --output text
```

Both should report the same two-rule policy; the preflight should print
`ECR lifecycle policy is release-safe`.

## 5. If the policy must change later

- Edit `lifecycleRules` in `hello-cdk/lib/cdk-stack.ts` and its CDK test.
- Run `scripts/ecrLifecyclePolicy.mjs` against the new text; it must stay
  release-safe (two rules, tagged `*`, at least 10 tagged, at least 10
  untagged, `expire` action, no `any` rule).
- Deploy through the normal reviewed stack path so the template records the
  change. Do **not** apply a policy with `put-lifecycle-policy` again: that is
  what created the template drift this record closes.
- Re-check `lastEvaluatedAt` and the retained manifests after the next push.

No AWS resource was modified for this record.
