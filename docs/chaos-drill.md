# Chaos drill response playbook

Purpose: detect, diagnose, explain, and recover from an instructor-triggered
failure using evidence. Nothing in this document authorises creating a
production failure. All commands are read-only unless a step is explicitly a
recovery action and explicitly approved.

Log queries and the full record schema are in [logging.md](logging.md). Alarm
definitions and the notification topic are in [alarms.md](alarms.md).

## Verified baseline (read-only, 2026-10-25)

| Item | Verified value |
| --- | --- |
| SSR URL | `https://d3jsso3b2vz1cp.cloudfront.net` |
| ECS service | `UniBudgetStack-ApplicationService423C69C6-YCFTDtV8bRhX`, `ACTIVE`, desired 1 / running 1, deployment `COMPLETED` |
| Running release | `UniBudgetStackApplicationTask3DB06674:4`, image tag `v1.1.3`, digest `sha256:168b26…`, registered 2026-10-25T19:37Z |
| Previous revision | `UniBudgetStackApplicationTask3DB06674:3`, image tag `v1` (rollback candidate, present in ECR) |
| Deployment strategy | `ROLLING`, min healthy 100% / max 200%, circuit breaker enabled with rollback |
| Target health | one target, `healthy` |
| Log group | `/unibudget/ecs/application`, 7-day retention |
| Metric filter | `{ $.level = "error" }` → `UniBudget/Application` `StructuredErrorCount` |
| Alarms | `UniBudgetStack-Monitoring-Target5xx`, `UniBudgetStack-Monitoring-UnhealthyTargets`, `UniBudgetStack-Monitoring-LiveTaskCount`, `UniBudgetStack-Monitoring-StructuredErrors`, `UniBudgetStack-Monitoring-Request5xx`; the first four were `OK` at review time, each with the SNS topic action. `Request5xx` was added on 2026-10-26 and was not yet deployed to production |
| Notification | one confirmed email subscription on `unibudget-production-alarms` |
| Static site | independent bucket `staticsitestack-…` and distribution `E2JVO3G1WG2Q2T`; not part of this application |

Behaviour that is **verified from live records**: every request writes one JSON
access record with `requestId`, `method`, `path`, `status`, `durationMs`;
health probes are logged like any other request; the running image is `v1.1.3`.

Behaviour that is **expected but not observed end to end**: an alarm crossing
its threshold from real traffic, inbox delivery, and the circuit-breaker
rollback. See [What is not proven](#what-is-not-proven).

## Record before you act

Write these into the incident note first. They are the evidence the drill is
assessed on, and they cannot be reconstructed after retention expires.

1. UTC time the symptom started and the time you observed it.
2. The failing URL/path and HTTP status, including the `X-Request-Id` response
   header when present.
3. The `requestId` from the response or from the matching access record.
4. Which alarm fired, its state at the time, and its state transition time.
5. The running task definition revision and image digest.
6. Recovery evidence: first successful request after the fix, its timestamp,
   and the revision/digest serving it.

## Scenarios

| Scenario | Detection signal | Evidence to inspect | Likely cause categories | Safe response |
| --- | --- | --- | --- | --- |
| Application returns 500 | `warn` access records with `status >= 500`; `Request5xx` alarm after one 1-minute period; `Target5xx` after two 5-minute periods; `StructuredErrors` only if an exception was recorded | `requestId`, the matching `error` record (`event`, `errorName`, `code`), deploy window, running digest, whether one `path` or all are affected | Route bug, failed query, missing migration, bad configuration, release regression | Correlate the records, scope the blast radius, fix forward or use the documented rollback; do not restart tasks for a code bug |
| Database unavailable | `/api/health` returns `503` while `/api/live` stays `200`; `UnhealthyTargets` alarm after ~2 min; `health.database.failed` error records | Health access records, `code` (`08…` connection, `42…` schema/permission), target health reason, ECS events (no task replacement), provider status | Supabase/pooler outage, rotated or wrong credentials, CA/TLS configuration, security-group or DNS change | Keep tasks running, confirm liveness, check the provider and credential source, follow the secret-rotation procedure; never print secret values |
| Target becomes unhealthy | `UnhealthyTargets` alarm; `describe-target-health` shows `unhealthy` with a reason | Target health reason, `/api/health` body over CloudFront, container liveness records, task events | Readiness failing on the database, wrong port or health path, security-group change, task still starting | Diagnose from the readiness record before changing anything; the process is not dead just because the target is unhealthy |
| Running task count falls | `LiveTaskCount` alarm (3 × 1 min, missing data is breaching); ECS service events | `stoppedReason`, container exit code and reason, image pull or secret errors, deployment state | Crash loop, failed liveness, image/secret problem, deployment in progress, task too small (256 CPU / 512 MiB) | Read the stop reason first; fix the cause and let the service converge. Do not scale to zero as a remedy |
| Unexpected 404 | `warn` access record with `status: 404` (no alarm by design) | Requested `path`, the same route from an earlier release, deployed revision and digest, CloudFront request id (`x-amz-cf-id`) | Wrong URL, route removed or renamed, deployment mismatch, catch-all returning 404 | Confirm whether the route exists in the running build; treat 404 as a routing question, not a crash |
| Authentication failure | `warn` access records for `401`/`403` (and `429` when rate-limited); no alarm | `requestId`, `path` (`/api/auth/*`, `/dashboard`), status, session cookie presence over HTTPS | Expired or invalid session, `Secure` cookie not sent over HTTP, login rate limit, session lookup failure | Verify HTTPS and cookie behaviour, distinguish `401` from `429`, inspect error records only when an exception was logged; never weaken authentication to "fix" it |

## First look: is it the application or the platform?

1. Open the access records for the last 15 minutes and group by `path` and
   `status` ([logging.md](logging.md#useful-saved-queries)).
2. If only one `path` fails, treat it as a route or code problem.
3. If every route fails at once, check the database readiness and the role gate
   before suspecting route code.
4. If no records arrive at all, the request never reached the application:
   check ECS service events, target health, and CloudFront.
5. Record the digest before forming a theory; never assume the deployed image
   matches the branch you are reading.

## Escalation criteria

Escalate to the repository owner (and, where relevant, the provider) when:

- 5xx responses persist for more than 15 minutes, or start immediately after a
  release and do not stop.
- Readiness fails for more than 10 minutes while liveness stays `200`
  (dependency outage; restarting tasks will not help).
- `LiveTaskCount` reports zero running tasks, or the service cannot reach a
  steady state.
- Any evidence suggests data loss, corruption, or cross-user data exposure.
- A credential, token, or connection string may have been exposed.

Stop writing data and escalate immediately if cross-user data exposure is
suspected; do not "repair" data before preserving evidence.

## Recovery checklist

Application rollback (only for a release-correlated failure, with approval):

1. Record the current revision and digest.
2. Confirm the target revision still exists and its image tag is present in
   ECR (`aws ecr describe-images`).
3. If the database password changed since that revision, restoring the old
   revision also requires the matching credential; coordinate both.
4. Update the service to the previous task definition revision, wait for a
   stable service, then verify `/api/live`, `/api/health`, `/login`, a real
   blog route, and an unknown-slug `404`.
5. Record the rollback start/finish timestamps and the digest now serving.

Rolling back from `v1.1.3` to `v1` also removes request correlation from the
running image; the application still serves traffic, but the access and error
records described in [logging.md](logging.md) disappear until a later release
is deployed. Prefer a forward fix when time allows.

Database recovery (last resort, forward-only migrations):

1. Application rollback does **not** reverse schema or data changes.
2. A restore requires a verified Supabase recovery point (backup or PITR) plus
   an operator with Supabase credentials; neither exists in this repository.
3. Coordinate the database restore with the application revision that matches
   the restored schema, then re-run every post-restore check.

## Recovery readiness

| Prerequisite | Status | Evidence or gap |
| --- | --- | --- |
| Documented rollback method matches architecture | **Verified from configuration** | ECS rolling deployment with a deployment alarm (and the circuit breaker enabled); previous revision exists |
| Last-known-good release identifiable | **Verified** | `v1.1.3` / rev 4 (running); `v1` / rev 3 (previous, in ECR) |
| ECR retains the rollback image | **Verified** | tag `v1` present; policy retains 10 tagged images |
| Deployment state inspectable | **Verified** | `describe-services`, `describe-tasks`, CloudWatch alarm history |
| Rollback actually exercised | **Proven in the isolated drill account, 2026-10-26** | Run 2 rolled back automatically on the deployment alarm and reached steady state 3 m 10 s after the broken revision was applied; run 1 needed a manual rollback. Not yet repeated in production |
| Supabase recovery point available | **Not verified** | Requires Supabase dashboard/API access not available to this review; no reference or timestamp on record |
| RDS legacy PITR usable for the app | **Not applicable** | The retained RDS instance is not the production database; its 1-day PITR window does not cover Supabase |
| Migration rollback scripts | **Not available** | Migrations are forward-only by design |

Do not claim full recovery readiness on the basis of this table: rollback has
been exercised in an isolated account but not in production, and no verified
database recovery point exists in this environment.

## Post-incident verification

- `/api/live` and `/api/health` return `200` through CloudFront.
- `/login` returns `200`, and a real `/blog/<slug>` returns `200`.
- An unknown blog slug returns `404` (not `200`).
- The five alarms are back to `OK`, with the state change recorded in alarm
  history.
- The serving task definition revision and image digest are the intended ones.
- The incident note contains the window, one representative `requestId`, the
  records for that id, and the recovery timestamps.

## Threshold review (applied 2026-10-26)

`Target5xx` and `StructuredErrors` both need two consecutive 5-minute periods
above five events, so a real crossing can take 10–15 minutes and a short burst
may never alarm. That is deliberate noise control for a single-task service
whose probes write records every 30 seconds, and those two thresholds are
unchanged.

What changed is the addition of a separate fast path, `Request5xx`, rather than
retuning the slow ones mid-drill: a `status >= 500` metric filter plus one
1-minute period at a threshold of zero, which is also the ECS **deployment
alarm**. The rollback drill retest on 2026-10-26 exercised it end to end —
`OK → ALARM` 33 s after the first bad probe, automatic rollback, `ALARM → OK`
after recovery. `docs/rollback-drill-2.md` §8 has the timeline; `docs/alarms.md`
has the definition.

`Target5xx` and `StructuredErrors` remain the slower notification paths. A short
500 burst that `Request5xx` catches will not reach either of them, so an alarm
email for a brief failure should not be expected.

## What is not proven

- Inbox receipt of an alarm email has not been independently verified. Alarm
  evaluation is proven: `Request5xx` crossed on real traffic on 2026-10-26 (see
  above), and its history record carries a threshold evaluation. The drill
  captured no `Action` history item, so delivery from the drill is unverified
  too. The earlier manual `StructuredErrors` `ALARM`→`OK` test on 2026-10-25
  proves only that CloudWatch executed the SNS action.
- The **circuit breaker** has not been shown to roll anything back. On a
  single-task service it needs three failed launches before it acts (ECS
  clamps the bounded-percent threshold to a minimum of three), which at run 1's
  one-failure-per-eight-minutes cadence is roughly 25 minutes. The deployment
  alarm is what stops a bad rollout here, in about 30 seconds. The breaker is
  best understood as restart behaviour plus a second line of defence for
  larger services.
- Task replacement during a **liveness** failure and database restore have not
  been exercised.
- The `500`-response correlation improvement in this branch is not part of
  the running `v1.1.3` image. The deployed middleware source rethrows unhandled
  errors into the framework's error path, and that path has not been observed
  in production, so the presence of `X-Request-Id` on a live 500 is unverified.
- None of this is deployed to the production account yet. `Request5xx` and the
deployment-alarm wiring exist in the drill account only.
