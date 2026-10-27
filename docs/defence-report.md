# UniBudget — final defence report

Status: **final report for the delivered system.** Written 2026-10-27 against
`main` at `2825fc2` and a read-only check of the production account
(`556890483680`, `us-east-1`). It separates what is deployed, what is proven by
evidence, and what remains open. Where a claim is not backed by a check, this
report says so.

## 1. Summary

UniBudget is a server-rendered budgeting application with a separately published
static blog, deployed to AWS by GitHub Actions using short-lived OIDC
credentials. The application runs on ECS Fargate behind a private ALB reached
only through CloudFront, with PostgreSQL on Supabase. Images are immutable,
semantic-versioned, and pushed by CI; migrations run as a one-off ECS task before
the service rollout; five CloudWatch alarms cover availability, 5xx responses,
structured errors, and unhealthy targets, and one of them is wired to ECS as a
rollback deployment alarm.

What is proven: the pipeline, the migration ordering, the immutable-image and
digest checks, the alarm wiring, and the metric/alarm behaviour in an isolated
drill account. What is not proven: an alarm-triggered rollback **in production**,
the least-privilege IAM policy (still a proposal, not attached), and viewer TLS
above `TLSv1` (blocked by the absence of a domain and certificate). Those are
reported as open, not as done.

## 2. System architecture

| Layer | Choice | Notes |
| --- | --- | --- |
| Application | Astro SSR on Node 24, container on port 8080 | `/api/health` liveness, `/login`, `/blog/:slug` dynamic route |
| Compute | ECS Fargate, one service, desired count 1 | Circuit breaker plus a CloudWatch deployment alarm |
| Edge | CloudFront, AWS-generated hostname, HTTP/2+3 | No aliases, no ACM certificate; origin reached over HTTP from CloudFront only |
| Origin protection | ALB security group restricted to the CloudFront origin-facing prefix list | The ALB has no public HTTP path |
| Static site | Separate Astro build published to S3 behind its own CloudFront distribution | Deployed by a separate workflow; no application or database dependency |
| Database | Supabase PostgreSQL, session pooler | `verify-full` with the Supabase CA stored in Secrets Manager |
| Secrets | Secrets Manager: `application`, `migration`, `ca` | Task definitions reference ARNs; the deploy role never reads the application secret |
| Images | ECR, immutable tags, semver `vMAJOR.MINOR.PATCH` | Ten tagged and ten untagged retention |
| Observability | CloudWatch Logs, two metric filters, five alarms, SNS topic | Request id returned on every response for correlation |
| Identity | GitHub OIDC role trusted for this repository and the `production` environment | No long-lived AWS keys in GitHub |

Two stacks are deployed separately: `UniBudgetStack` (VPC, ALB, ECS, ECR,
CloudFront, secrets) and `UniBudgetStack-Monitoring` (alarms, metric filters).
The monitoring stack imports the application stack's topic and resources, so the
application stack can be updated without recreating monitoring, and alarm changes
need their own `monitoringOnly` synthesis.

## 3. Delivery pipeline and ordering

1. **Tests first.** CI runs the Vitest suite against a disposable PostgreSQL 16
   service. Integration suites fail closed rather than skipping when CI is set.
2. **Pre-flight gates.** The deploy workflow verifies the assumed account matches
   `AWS_ACCOUNT_ID`, resolves the CloudFront origin-facing prefix list, confirms
   the stack exists, checks the deployment alarm exists and measures
   `UniBudget/Application/Http5xxCount`, and refuses an unsafe ECR lifecycle
   policy before building.
3. **Immutable image.** The build pushes `${IMAGE_TAG}` once, rejects a tag that
   already exists, and records the digest. Tags are immutable in ECR.
4. **Migration before rollout.** A temporary revision of the migration task
   family is registered with the new image, run once, checked for exit code 0,
   then deregistered. The service is not touched until the migration succeeds.
   The migration task receives only the migration secret and the CA.
5. **Stack update.** `cdk deploy` runs with the image tag, desired count, alarm
   name, Supabase host, and prefix list as validated context. The service
   watches the alarm with `rollback: true`.
6. **Post-deploy proof.** The workflow waits for service stability, then verifies
   the running task's image digest equals the pushed digest, that the deployment
   alarm is attached and enabled, that the primary rollout is `COMPLETED`, and
   that `/api/health`, `/login`, a real blog slug, an unknown slug (404), and the
   `X-Request-Id` header behave through CloudFront.

The ordering is the answer to the classic failure mode: a schema migration that
succeeds while the service rolls back would leave code and schema mismatched, so
the migration runs first and its failure stops the release before any task-set
change.

## 4. Verified production state

Read-only checks on 2026-10-27:

| Item | Observed |
| --- | --- |
| `main` | `2825fc2`, level with `origin/main`; CI on that commit passed |
| ECS service | `ACTIVE`, desired 1 / running 1 / pending 0, rollout `COMPLETED` |
| Running task definition | `UniBudgetStackApplicationTask3DB06674:4` |
| Running image | `…/unibudgetstack-applicationrepository13e54097-nb3o4t9o4cok:v1.1.3` |
| Deployment alarm | `UniBudgetStack-Monitoring-Request5xx`, `enable: true`, `rollback: true` |
| Alarms | Five, all `OK` (`LiveTaskCount`, `Request5xx`, `StructuredErrors`, `Target5xx`, `UnhealthyTargets`) |
| SSR distribution | `E30KFH719MS9Z0` → `d3jsso3b2vz1cp.cloudfront.net`, `Deployed` |
| Static distribution | `E2JVO3G1WG2Q2T` → `d2eip6kpluaijf.cloudfront.net`, `Deployed` |
| Viewer TLS | `TLSv1`, default certificate, no aliases, `sni` not used (`vip`) |
| ECR | Four manifests: `v1.1.3`, `v1`, two untagged; policy tagged/10 + untagged/10 |
| ECR policy consistency | Live policy, deployed template, and CDK definition agree |
| ACM / Route 53 | No certificates, no hosted zones |
| Deploy role | `unibudget-github-deploy` with `AdministratorAccess` attached |

The ECR reconciliation matters because the policy was once applied out of band:
live and template disagreed, and the rollback window could have silently shrunk.
The template now records the same ten/ten policy, and the workflow still refuses
to build if the live policy becomes unsafe.

## 5. Evidence, and what it does not cover

**Rollback.** Rollback Drill 2 ran twice on 2026-10-26 in an isolated account
(`293633790894`), not in production. Run 1 was a partial pass: the circuit
breaker alone could not stop a one-task service because ECS clamps its failure
threshold, so the rollout was stopped manually. That finding produced the
`Request5xx` deployment alarm; run 2 failed the health check, tripped the alarm
in 33 seconds, and rolled back automatically in 3m10s. The same wiring is now
live in production, where **no rollout has yet tripped the alarm**. Production
rollback is therefore a design with drill evidence, not an exercised path.

**Alarms and notifications.** Alarm state transitions and ECS rollback events
are captured in the drill evidence. SNS delivery counts were observed for one
check; independent receipt in an inbox is not proven, and this report does not
claim it.

**Static site.** Its CloudFront distribution is live and the workflow verifies
the bucket, distribution, origin, TLS redirect, and 404 mapping before uploading.
The static stack's CDK source is outside this repository, so its infrastructure
changes are a separate deliverable.

**Least privilege.** The scoped policy has been validated only as JSON and with
Access Analyzer. It has not been attached anywhere and its permissions have not
been exercised against all three workflows; see §6.

## 6. Security posture

Applied:

- OIDC federation with a trust policy limited to this repository and the
  `production` environment; no AWS access keys in GitHub.
- Immutable image tags and digest verification, so the running artefact is the
  built artefact.
- Separate application and migration task roles, each with its own secret scope;
  the deploy role cannot read the application secret.
- ALB reachable only from the CloudFront origin-facing prefix list.
- Public entry over HTTPS with an HTTP→HTTPS redirect, cache disabled for
  authenticated responses, and all viewer headers and cookies forwarded.
- S3 buckets private, backup bucket encrypted and versioned, dumps checksummed
  on upload and read back.

Proposed or open:

| Risk | Current state | Why it is not fixed yet |
| --- | --- | --- |
| Deploy role has `AdministratorAccess` | Outstanding | The scoped policy is a proposal; its permissions are unvalidated against all three workflows, and no staging account exists to validate them. Applying it untested would risk every release. |
| CDK bootstrap roles remain broad | Outstanding | Phase 2 needs a bootstrap re-run with `--cloudformation-execution-policies` and its own review. |
| Viewer TLS is `TLSv1` | Accepted platform limitation | The default `*.cloudfront.net` certificate cannot use `TLSv1.2_2021`; a custom domain and an ACM certificate are required, and the account has neither. The deploy workflow deliberately rejects aliases and certificates, so the change is coordinated code + workflow + DNS work. |
| One role serves deploy, static, and backup | Accepted for Phase 1 | Splitting into three roles with three environments is Phase 3 in the IAM proposal. |

The IAM position is deliberate and documented: the policy is a proposal, the
role still has account-wide access, and staging validation is a future security
task blocked on a designated account. That is a weaker position than a completed
migration, and the record says so rather than claiming least privilege.

## 7. Residual risks

| Risk | Impact | Mitigation today | Closing trigger |
| --- | --- | --- | --- |
| Compromise of the deploy identity | Account-wide change capability | OIDC subject restricted to repo + `production` environment; environment protection rules; CloudTrail | Attach the scoped policy after a passing staging validation |
| Production rollback never exercised | A real bad rollout may behave differently from the drill | Alarm wired with `rollback: true`; drill proved the mechanism in an isolated account | First real failed production rollout, or a controlled production drill with approval |
| TLS 1.0/1.1 accepted at the edge | Weak protocol exposure | Redirect to HTTPS; no sensitive endpoints over plain HTTP | Domain + ACM certificate, then the staged migration in the TLS plan |
| Bootstrap execution role unscoped | Stack-level changes survive role scoping | Phase 1 policy limits direct account actions | Phase 2 bootstrap update |
| Static stack source outside the repo | Its infrastructure cannot be reviewed here | Workflow pre-flight proves the live target before upload | Import the stack source, or treat it as a separate deliverable |

## 8. Likely defence questions

**"Is the deployment role least-privileged?"** No. It still has
`AdministratorAccess`. A scoped policy exists as a reviewed proposal with 21
statements, but it has not been attached because it has not been validated
against all three workflows. The document, the readiness record, and the risk
register all say this plainly.

**"How do you know the running image is the one CI built?"** The workflow records
the digest returned by ECR after push, then compares it with the digest reported
by the running task, and fails the release on a mismatch. Tags are immutable.

**"What happens if a migration succeeds but the rollout fails?"** The migration is
backward-compatible with the previous image by design, and the rollout rolls back
to the previous task definition. The recovery point for the migration is attested
before the run: the workflow requires a verified restorable backup or PITR point
and records its reference and timestamp.

**"Has the rollback actually run in production?"** No. It ran twice in an
isolated account; the production wiring is live but has not been tripped. The
honest answer is "drilled, not exercised in production".

**"Why is TLS 1.2 not enforced?"** Because the distribution uses the AWS default
certificate on a `*.cloudfront.net` hostname, which only supports the `TLSv1`
viewer policy. Raising it needs a custom domain and an ACM certificate, and the
deploy workflow currently rejects both by design to prevent drift. The migration
requirements and rollback are documented.

**"What would you do next?"** In order: designate a staging account and validate
the IAM policy there; scope the bootstrap execution role; obtain a domain and
move both distributions to `TLSv1.2_2021`; and exercise the alarm rollback in
production under a controlled change.

## 9. Verification log

Every statement about the account in this report comes from read-only calls on
2026-10-27: `sts get-caller-identity`, `iam` (role, attached and inline
policies, bootstrap roles, trust policies), `ecr` (repositories, images,
lifecycle policy), `ecs` (cluster, service, task definitions), `cloudwatch`
(alarm names and states), `cloudfront` (both distributions and their viewer
certificate settings), `acm list-certificates`, `route53 list-hosted-zones`,
`s3api` (buckets, encryption, versioning), `secretsmanager` (secret metadata
only; no secret value was read), `kms describe-key`, `cloudformation`
(template and stack metadata), and `ssm`. No write call was made.

## 10. Document map

- [deployment.md](deployment.md) — architecture, release sequence, recovery
- [release-readiness.md](release-readiness.md) — release gates and remaining risks
- [iam-least-privilege.md](iam-least-privilege.md) — the proposal and its limits
- [iam-staging-validation-plan.md](iam-staging-validation-plan.md) — deferred validation and prerequisites
- [ecr-lifecycle-reconciliation.md](ecr-lifecycle-reconciliation.md) — retention evidence
- [cloudfront-tls-plan.md](cloudfront-tls-plan.md) — TLS migration requirements
- [rollback-drill-2.md](rollback-drill-2.md), [rollback-drill-2-result.md](rollback-drill-2-result.md) — drill method and result
- [alarms.md](alarms.md), [logging.md](logging.md) — observability contract
- [backup-and-recovery.md](backup-and-recovery.md) — backup design
- [defence-5-minutes.md](defence-5-minutes.md) — the short spoken brief
- [final-sdlc-report.md](final-sdlc-report.md) — SDLC deliverable record
