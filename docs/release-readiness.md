# UniBudget release readiness

Last updated: 2026-10-25

This document separates what is implemented from what is tested, merged,
deployed, and verified in production. A green local suite is not a deployment.

## Current baseline

| Item | State |
| --- | --- |
| `main` | `77fea3f` — merge of PR #39 |
| Working branch | `feat/final-project-hardening` (new changes; not merged or CI-verified) |
| Production image | `...:v1`, digest `sha256:1a68b6ef…` |
| ECS service | `ACTIVE`, desired 1 / running 1, primary deployment `COMPLETED` |
| `/api/health` | **200** |
| `/login` | **200** |
| `/blog/first-post` | **500** — the running image predates the SSR fix |
| CloudWatch alarms | none in the account |
| ECR policy | live `tagStatus: any`, keep 5; **not** the CDK policy |
| ECR images | 3 manifests (tagged `v1` plus two untagged) |
| Rollback Drill 2 | not executed |

Read-only checks on 2026-10-25 confirmed the production service and route
status above. No deployment was performed for this report.

## Readiness matrix

| Area | Implemented | Locally tested | CI verified | Deployed | Verified in production |
| --- | --- | --- | --- | --- | --- |
| Blog SSR route | yes | yes (unit + built-server 200/404) | pending new branch | no (fix not in `v1`) | **no — 500** |
| Liveness/readiness split | yes | yes (unit + Docker runtime) | pending | yes for `v1` | health 200; blog route still fails |
| Deployment test gate | yes | yes (contract) | pending | n/a | n/a |
| Post-deploy health/login/blog/404 checks | yes | yes (contract; local route check) | pending | no | no |
| Image provenance labels | yes | contract test | pending | no | no |
| Semantic tag validation | yes | yes (unit + workflow contract) | pending | no | no |
| Tag-to-commit enforcement | yes | yes (workflow contract) | pending | no | no |
| ECR retention preflight | yes | yes (policy unit + live read-only) | pending | no | live policy is unsafe |
| CloudWatch alarms + metric filter | yes | CDK 20/20 | pending | **no** | no |
| SNS notification action | optional CDK support | CDK tests | pending | **no topic/subscription** | no |
| CDK ADRs and runbooks | yes | documentation review | n/a | n/a | n/a |
| Least-privilege deploy role | proposal only | n/a | no | no | role has `AdministratorAccess` |
| Rollback Drill 2 | runbook only | n/a | no | no | not executed |

## Local verification performed on this branch

- `npm test -- --run` with a disposable local PostgreSQL 16 container:
  **229 passed, 0 failed, 0 skipped** across 27 files. This includes the two
  PostgreSQL integration suites, which skip only when no test database is
  configured.
- `npm run check`: 0 errors, 0 warnings, 0 hints.
- `npm run lint`: 0 errors, 6 pre-existing `no-console` warnings in diagnostic
  scripts and ignored `artifacts/`.
- `npm run build`: succeeded with the Node standalone adapter.
- Built server (`node scripts/start.mjs`, local port): `/blog/first-post`
  **200** with the expected title and body, an unknown slug **404**, extra or
  malformed path segments **404**, `/api/live` **200**.
- CDK Jest: **20/20 passed**; `cdk synth` succeeded with four alarms, one
  metric filter, zero stack-created SNS topics, and the ten/ten lifecycle
  policy in the template.
- `docker build` from `dockerfile`: succeeded; OCI version/revision labels
  carried the supplied release string and `GITHUB_SHA` equivalent. The runtime
  image answered `/api/live` **200** and `/api/health` **503** with no database
  configuration, proving liveness and readiness are independent.
- Both workflow files parse as YAML and all 28 embedded `run` blocks pass
  `bash -n`.
- The live ECR policy fails the new preflight; the synthesized ten/ten policy
  passes it. The live repository, ECS service, image digest, alarms, and
  production routes were re-checked read-only on 2026-10-25.

## Status ladder

These are separate states. A later state is not implied by an earlier one.

| State | Current status |
| --- | --- |
| 1. Code complete | Yes for the application, health, workflow, alarm, lifecycle, provenance, ADR, and runbook work on this branch. IAM least privilege and Rollback Drill 2 remain proposals/runbooks, not completed external changes. |
| 2. Locally tested | Yes: 229 Vitest tests (including both PostgreSQL integration suites against a disposable local container), 20 CDK tests, Astro check/lint/build, workflow YAML and shell syntax, CDK synthesis, Docker build/runtime, and a built-server SSR route check. |
| 3. CI verified | **No.** This branch has not been pushed or run through GitHub Actions. |
| 4. Ready for deployment | **No.** See the explicit blockers below. |
| 5. Deployed | **No.** Production still runs the legacy `v1` image. |
| 6. Verified in production | **No.** `/blog/<slug>` still returns 500 in production. |

## Release candidate

The next release should be **`v1.1.0`**, not `v2.0.0`:

- the changes fix the `/blog/:slug` 500 and add operational hardening and
  observability without changing the public API or database schema contract;
- `v1.0.0` already exists and must not be moved;
- the deployed `v1` is a legacy image with unproven provenance;
- a minor version records new backward-compatible capability while avoiding a
  false major-version claim.

The release tag, ECR tag, OCI `version`, and recorded digest must all be
`v1.1.0`. Do not create or push the tag until the code is merged, CI is green,
and the ECR policy has been applied.

## Required sequence before the next production release

1. **Merge the hardening branch and verify CI.** The new workflow gates and
   tests must pass on the exact commit to be released.
2. **Apply the ECR lifecycle policy before any image push.** The live
   `tagStatus: any`/5 policy counts the OCI index, platform manifest, and
   attestation together. Apply the CDK policy with an approved `cdk deploy`
   using the currently deployed `v1` image and desired count, or apply the
   same policy through an approved ECR change. Then re-run the read-only
   policy assessment. The deployment workflow now fails before build if the
   live policy is still unsafe.
3. **Create and confirm the SNS notification path.** Create a topic, add a
   confirmed operator subscription, grant `cloudwatch.amazonaws.com` publish
   permission in the topic policy, and set the protected repository variable
   `ALARM_TOPIC_ARN`. The stack imports the topic; it does not create or
   subscribe one. See [alarms.md](alarms.md).
4. **Choose the release commit and tag.** Create annotated tag `v1.1.0` on the
   merged commit and push it. Do not move `v1.0.0`. The deployment workflow
   now refuses a normal release unless that annotated tag exists and points at
   the exact `GITHUB_SHA` being built; dispatch it from that commit.
5. **Deploy through the workflow.** Provide the verified recovery point,
   `imageTag=v1.1.0`, and an explicit desired count. The workflow builds,
   pushes, records the digest, migrates, deploys, and verifies the running
   digest plus `/api/health`, `/login`, a real blog slug, and an unknown-slug
   404.
6. **Verify in production.** Confirm the new digest and the blog route over
   CloudFront, and confirm a test alarm notification if the SNS path was
   enabled.
7. **Run Rollback Drill 2 in the isolated drill account** before claiming
   rollback readiness.

## Explicit blockers

- The production image still returns **500** for `/blog/<slug>`.
- The live ECR policy is unsafe for the next push.
- No CloudWatch alarms exist in the account and no SNS subscription is
  confirmed.
- The deployment role still has `AdministratorAccess`; least privilege is a
  proposal, not applied.
- No `v1.1.0` tag or image exists.
- Rollback Drill 2 has not been executed.
- The new branch has not been pushed, reviewed, or CI-verified.

## Operations deliberately not performed

No production deployment, image push, release tag, migration, IAM change,
GitHub secret/variable change, DNS/certificate change, ECR policy application,
AWS resource modification, merge, or rollback drill was performed while
preparing this document.
