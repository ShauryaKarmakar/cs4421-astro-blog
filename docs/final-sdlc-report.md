# UniBudget SDLC completion report

Date: 2026-10-25
Reviewed base: `main` at `4ce73f9` (merge of PR #40)
Work branch: `feat/request-logging` at `be862db`
Production account: `556890483680`, region `us-east-1`

This report separates code that exists from code that is tested, merged,
deployed, and observed in production. A green local suite is not a deployment.

## 1. Checkpoint matrix

| # | Checkpoint | Status | Evidence | Remaining work |
| --- | --- | --- | --- | --- |
| 1 | Functionality | **Needs production verification** | `/blog/[...slug].astro` looks up the entry from the URL and sets `Astro.response.status = 404`; built image returns `/blog/first-post` 200 with `<title>First post</title>`, unknown and nested slugs 404, `/login` 200. Production still returns 500 because it runs the pre-fix `v1` image. | Release `v1.1.0` and re-check `/blog/first-post` and an unknown slug over CloudFront. |
| 2 | Test suite | **Complete** | 242/242 Vitest tests pass with a disposable PostgreSQL 16 container (28 files, no skips); 236 pass with 6 integration skips when no database is configured; 30/30 CDK tests; `astro check` 0 errors; ESLint 0 errors (6 pre-existing warnings in diagnostic scripts); production build succeeds. | None. CI must run on the new branch/PR. |
| 3 | Readiness vs liveness | **Complete** (local); production outage path not exercised | `/api/live` never touches PostgreSQL; `/api/health` asserts the application role and runs a bounded `SELECT 1` on a 2 s/2.5 s timeout pool. Both return generic JSON with `no-store`. Container with no database: `/api/live` 200, `/api/health` 503. Production: both 200 today. | Optional: observe the split during a controlled database blip; not required to complete the checkpoint. |
| 4 | CI/CD workflow | **Complete**; release not executed | `ci.yml` runs check, lint, tests, build, Docker build, migration-module check, CDK build/test/synth. `deploy.yml` validates inputs, requires an annotated semver tag on the dispatched commit, runs tests before building, enforces the ECR retention preflight, verifies CloudFront/origin, runs the one-off migration task before the rollout, then verifies rollout state, running digest, `/api/health`, `/login`, a real blog slug, and an unknown-slug 404. Concurrency group `unibudget-production`, `cancel-in-progress: false`, `production` environment. | Execute one release (`v1.1.0`) under approval. Blue/green is explicitly out of scope. |
| 5 | Containerization | **Complete** | Multi-stage `node:24-bookworm-slim`; `npm ci`, build, `npm prune --omit=dev`; runtime copies only `dist`, production `node_modules`, `migrations`, `start.mjs`, `migrate.mjs`, `postgresConfig.mjs`; runs as `uid=1000(node)`; `EXPOSE 8080`; liveness `HEALTHCHECK`; OCI version/revision labels verified (`v1.1.0-verify`, `4ce73f9b…`); `.dockerignore` excludes `.env*`, certs, keys, artifacts, tests, docs, CDK. | None. Image was built and run locally, not pushed. |
| 6 | CloudWatch | **Deployed; mailbox receipt unconfirmed** | Log group `/unibudget/ecs/application` exists with 7-day retention and receives container output. SNS topic `unibudget-production-alarms` exists with a CloudWatch-scoped publish policy and a **confirmed** email subscription (`karmakarshaurya@gmail.com`, real subscription ARN). A read-only check on 2026-10-26 shows four deployed alarms (`LiveTaskCount`, `StructuredErrors`, `Target5xx`, `UnhealthyTargets`), all `OK`, actions enabled and pointing at the topic, plus the application error metric filter; the earlier "0 alarms" reading in this row is superseded by the deployed monitoring stack. Live ECR policy is the approved 10 tagged / 10 untagged rule. | Mailbox receipt of an alarm email is still unconfirmed; confirm it out of band. No monitoring deployment remains pending. |
| 7 | Architecture Decision Records | **Complete** | `docs/adr/0001`–`0011` cover Astro SSR/Node, Supabase PostgreSQL, Docker/ECS Fargate, CloudFront/private ALB, liveness/readiness, rolling deployment and rollback, CI/CD migration ordering, immutable images and semver, CloudWatch observability, GitHub OIDC least privilege, and HTTPS without a custom domain. ADR 0009 was amended with the logging schema. | None. |
| 8 | Readiness/liveness probes | **Complete** (local failure evidence) | ECS container probe: `/api/live`, interval 30 s, timeout 5 s, 3 retries, 40 s start period. ALB target group: `/api/health`, interval 30 s, timeout 5 s, healthy 2, unhealthy 3, matcher 200. No database in the liveness path; the trade-off (drain the target instead of replacing the process) is documented in `deployment.md` and ADR 0005. | Production failover was not simulated; no probe settings were changed. |
| 9 | Detailed logs | **Code complete; needs production verification** | Requests now emit one JSON access record with `timestamp`, `level`, `event`, `requestId`, `method`, `path`, `status`, `durationMs`; errors emit `timestamp`, `level`, `event`, `errorName`, optional SQLSTATE `code`, and the same correlation fields. `X-Request-Id` is returned. Query strings, cookies, bodies, messages and stacks are not logged; paths are capped at 512 characters. Verified in the built container, including matching `requestId` on an error and its access record. | The deployed `v1` image still emits only framework text. Logs reach the group and the runbook (`docs/logging.md`) is ready; schema becomes observable after `v1.1.0` deploys. |
| 10 | AWS architecture/design | **Documentation complete; two open operational items** | Architecture is documented in `docs/deployment.md`, the ADRs, `docs/alarms.md`, `docs/logging.md` and `docs/iam-least-privilege.md`: CloudFront HTTPS → ALB (HTTP, CloudFront prefix list only) → ECS Fargate → Supabase PostgreSQL with `verify-full` and a CA from Secrets Manager; ECR immutable tags; separate task/execution roles; CloudWatch logs/metrics/alarms/SNS; rolling deployment with circuit-breaker rollback. | The deploy role still has `AdministratorAccess` (plan only, by instruction); Rollback Drill 2 has not been executed. |

## 1a. Updates after this review

- **2026-10-26, monitoring:** four alarms and the error metric filter are
  deployed in `UniBudgetStack-Monitoring`; all alarms are `OK` with actions
  enabled. SNS reported one delivered and zero failed notifications for a
  controlled publish. The mailbox itself has not been inspected, so inbox
  receipt stays **unconfirmed**.
- **2026-10-26, request correlation:** the deployment workflow now fails a
  release when `/login` does not return a well-formed `X-Request-Id` header.
  The gate is tested in the repository but not yet part of a released image.
- **2026-10-26, recovery:** a backup and recovery runbook
  ([backup-and-recovery.md](backup-and-recovery.md)) records the verified
  bucket properties, the restore procedure and the open RPO/RTO decision.
  No new restore was performed.
- **Rollback Drill 2 remains unexecuted.** No isolated account has been
  provisioned, so no drill result exists.

## 2. What this review changed

Only confirmed gaps were implemented. Existing work (PR #39, PR #40) was not
redone.

- **Request logging and correlation** (`src/middleware/auth.ts`,
  `src/lib/serverLogger.ts`, new `src/lib/requestContext.ts`). Before this
  change, production error lines had no timestamp, route, method, status,
  latency, or correlation id, so a 5xx could not be tied to a request.
- **Tests** (new `tests/requestLogging.test.ts`, 12 tests): schema and
  timestamp, probe records, caller/generated request ids, concurrent isolation,
  error/access correlation, immutable redirect headers, query/cookie/header
  redaction, path capping, unhandled failure records, no-correlation records,
  message/stack redaction, and control-character escaping.
- **Documentation**: ADR 0009 amended; new `docs/logging.md` with the field
  contract, example records, six Logs Insights queries, and the repeatable
  alarm-to-log workflow. Narrow schema corrections were also made in
  `docs/alarms.md` and `docs/deployment.md` (these two files also carry
  pre-existing uncommitted edits; see section 8).
- **No infrastructure change** was required for the logging work: the existing
  metric filter already matches `$ .level == "error"`, and access records use
  `warn` for 4xx/5xx so one failure is counted once.

## 3. SDLC summary

1. **Requirements and planning.** The ten checkpoints were mapped to the
   existing implementation; the baseline matrix in section 1 records what was
   complete, what needed changes, and what needs production evidence. The
   smallest safe change set was chosen: one code workstream (logging) plus
   verification and documentation, leaving already-correct health, container,
   workflow, and CDK work untouched.
2. **Implementation.** Request-scoped context uses `AsyncLocalStorage`, so the
   existing 20+ `logServerError(event, error)` call sites correlate without
   signature changes and concurrent requests cannot leak context. Access
   logging sits in the middleware around the existing auth and role-gate logic;
   behaviour is preserved.
3. **Testing.** Unit and contract tests were added for every new field and for
   the redaction boundary. The full suite, CDK tests, type check, lint, build,
   workflow-shell tests, Docker build and runtime were exercised (section 4).
   The PostgreSQL integration suites were run against a disposable container,
   not skipped.
4. **Review and integration.** The work is isolated on `feat/request-logging`
   based on `origin/main` (`4ce73f9`). No other branch was rewound, stashed, or
   deleted. Pre-existing working-tree changes and new concurrent files were
   left untouched.
5. **Release readiness.** Local and container evidence is complete; the
   production actions in section 7 are staged but not performed. No image was
   pushed, no tag was created, no migration was run, and no AWS or IAM resource
   was modified in this session.

## 4. Test evidence

| Command | Result |
| --- | --- |
| `npx vitest run --testTimeout=30000` with `BUDGET_TEST_DATABASE_URL` and `MIGRATION_TEST_DATABASE_URL` on a disposable `postgres:16` container | **28 files, 242 tests passed, 0 failed, 0 skipped** |
| Same suite without a database | 26 files passed, 2 files skipped; **236 passed, 6 skipped** (integration only) |
| `npx vitest run` at the default 5 s timeout on this Windows host | 4 subprocess-driven migration-workflow tests time out under 28-way parallelism; each takes 1.3–6.1 s alone. They pass as a file (8/8) and with `--testTimeout=30000` (242/242). Pre-existing environmental flake, not a code failure; CI uses the same default and previously passed. |
| `npx vitest run tests/requestLogging.test.ts` | **12/12 passed** |
| `npx vitest run tests/live.test.ts tests/health.test.ts` | 9/9 passed |
| `npm run check` (`astro check`, 64 files) | 0 errors, 0 warnings, 0 hints |
| `npm run lint` | 0 errors, 6 pre-existing `no-console` warnings (`artifacts/`, two diagnostic scripts) |
| `npm run build` | succeeded (Node standalone adapter) |
| `cd hello-cdk && npm run build && npx jest --runInBand` | **2 suites, 30/30 tests passed** (includes the concurrent monitoring-stack work, section 8) |
| `docker build -f dockerfile` | succeeded; manifest `sha256:649aba9e…`; labels `v1.1.0-verify` / `4ce73f9b…` |
| Container, `NODE_ENV=production`, no database | `/api/live` 200; `/api/health` 503; other routes 503 from the role gate (expected without a database); `X-Request-Id` on every response; JSON access + error records with matching `requestId`; no credential material in logs; `uid=1000(node)` |
| Container, `NODE_ENV=test`, no database | `/blog/first-post` 200 `<title>First post</title>`; `/blog/second-post` 200; unknown slug 404 `<h1>Post not found</h1>`; nested slug 404; `/login` 200; `/api/live` 200; `/api/health` 503 |
| `UNIBUDGET_AWS_ACCOUNT=… npx cdk diff UniBudgetStack --no-change-set` with live context | **+4 alarms, +1 metric filter, ~ECR lifecycle policy text only**; no ECS service, task definition, image, migration, IAM, or log-group change |
| `git diff --check` on changed files | clean |

`tests/blogRoute.test.ts` includes the 404-status assertion from the previous
hardening work; it passes.

## 5. Production status (read-only, 2026-10-25)

| Item | Observed |
| --- | --- |
| Stack | `UniBudgetStack` `UPDATE_COMPLETE`, last updated 2026-10-24 22:59 UTC |
| Public URL | `https://d3jsso3b2vz1cp.cloudfront.net` (distribution `E30KFH719MS9Z0`, `Deployed`) |
| Viewer TLS | `TLSv1` minimum — security weakness, unchanged; custom certificate work is out of scope |
| ECS service | `ACTIVE`, desired 1 / running 1, primary rollout `COMPLETED` since 2026-10-24 22:52 UTC |
| Running image | `…/unibudget…:v1`, digest `sha256:1a68b6ef…`, task definition revision 3 |
| `/api/live`, `/api/health`, `/login` | 200, 200, 200 |
| `/blog/first-post`, unknown blog slug | **500, 500** — stale image, fixed in code |
| ECR | 3 images (tagged `v1` + two untagged); lifecycle = tagged `*`/10, untagged/10 |
| Log group | `/unibudget/ecs/application`, 7-day retention, active `application/…` and `migration/…` streams |
| Current log format | Plain text with framework stack traces: no request id, method, path, status, or duration |
| Alarms / metric filters | **0 / 0** |
| SNS | Topic exists; **one confirmed** email subscription; no alarm actions attached yet |
| Deploy role | `unibudget-github-deploy`, `AdministratorAccess`, no inline policies; trust pinned to this repo's `production` environment |
| CI | `main` at `4ce73f9` — run 40205320366, `CI`, conclusion `success` |

## 6. Architecture and operations documentation

| Document | Purpose |
| --- | --- |
| `docs/adr/0001`–`0011` | Decisions and alternatives for SSR, database, containers, edge delivery, health checks, rollout, migration ordering, immutable releases, observability, OIDC, HTTPS |
| `docs/deployment.md` | End-to-end deployment sequence, context values, probe strategy, observability |
| `docs/alarms.md` | Alarm definitions, thresholds, missing-data behaviour, notification topic policy, triage, monitoring-only deployment path |
| `docs/logging.md` | Log schema, redaction rules, Logs Insights queries, alarm-to-request workflow |
| `docs/iam-least-privilege.md` | Verified role state, permission inventory, staged migration plan |
| `docs/rollback-drill-2.md` | Rollback drill runbook and prerequisite status (not executed) |
| `docs/release-readiness.md` | Status ladder, release candidate, evidence checklist |
| `docs/week7-deliverables.md` | Week 7 SRE evidence |
| `docs/final-sdlc-report.md` | This report |

## 7. Remaining actions (smallest safe sequence)

No production change is authorised by this report.

1. Review and push `feat/request-logging`, open a PR, and let CI run on it.
2. Apply the reviewed monitoring change under approval: 4 alarms, 1 metric
   filter, ECR template reconciliation. Either the reviewed direct `cdk deploy`
   path in `docs/alarms.md` or the concurrent `UniBudgetStack-Monitoring` stack
   may be used — not both, since that would duplicate every alarm. Set the
   protected `ALARM_TOPIC_ARN` repository variable.
3. Confirm the subscription state, then publish one approved test message and
   record one real alarm transition with a delivered email. Until then
   notification delivery is unproven.
4. Create annotated tag `v1.1.0` on the merged commit and dispatch `Deploy`
   from that commit with a verified Supabase recovery point and
   `desiredCount=1`.
5. Verify in production: running digest equals the recorded `v1.1.0` digest,
   `/api/health` 200, `/login` 200, `/blog/first-post` 200, unknown slug 404,
   and JSON log records with `X-Request-Id` in `/unibudget/ecs/application`.
6. Start the least-privilege IAM migration from CloudTrail evidence (owner
   approval required); do not replace `AdministratorAccess` with a guessed
   policy.
7. Run Rollback Drill 2 in an isolated account before claiming rollback
   readiness.
8. Commit the pre-existing documentation edits left in the working tree by the
   previous review (section 8).

## 8. Working-tree state not authored by this session

The checkout contains work from other sessions that this review preserved
byte-for-byte and did not commit:

- Modified: `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/alarms.md`,
  `docs/deployment.md`, `docs/iam-least-privilege.md`,
  `docs/release-readiness.md`, `docs/rollback-drill-2.md`,
  `docs/week7-deliverables.md`, `tests/blogRoute.test.ts`.
- Untracked: `hello-cdk/cdk.context.json`.
- Appeared during this session (concurrent monitoring work): modified
  `hello-cdk/bin/cdk.ts` and new `hello-cdk/lib/monitoring-stack.ts`,
  `hello-cdk/test/monitoring-stack.test.ts`. They compile and their 10 new CDK
  tests pass, but they are not part of commit `be862db` and were not reviewed
  for deployment safety here.

My documentation edits to `docs/alarms.md` and `docs/deployment.md` are in the
same working-tree files as the pre-existing edits and are therefore also
uncommitted; the committed ADR and `docs/logging.md` carry the authoritative
schema.
