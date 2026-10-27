# Rollback Drill 2 — blameless post-mortem and defence answer

**Evidence document — can be included with the drill record.**

Status: **run-1 post-mortem (executed 2026-10-26; partial pass).** A second run
followed the same day after the fixes described in the addendum below; the
canonical two-run record is [rollback-drill-2.md](rollback-drill-2.md).

The canonical execution record is
[rollback-drill-2.md](rollback-drill-2.md) §7. This document adds the blameless
post-mortem, the alarm analysis, and the answer to use in the defence. It does
not replace the runbook.

> **Addendum, 2026-10-26 (later the same day).** Sections 1–11 below are the
> post-mortem of **run 1** and are preserved as written, including its
> "proposed, not applied" action item. A second run was then executed in the
> same disposable account after the fixes were implemented: the new
> `Request5xx` alarm transitioned `OK → ALARM`, ECS failed the deployment with
> `deployment failed: alarm detected` and rolled back with no operator action,
> and the public endpoint stayed 200. See
> [rollback-drill-2.md](rollback-drill-2.md) §8 and `drill-evidence-retest/`.
>
> Two statements below were corrected in place because the retest and the AWS
> documentation contradict them: the proposed filter's firing time (§5, an
> alarm evaluates at a period boundary, not on the probe itself), and the
> reason `Target5xx` stayed `OK` (§5, ELB does not count health-check requests
> in that metric at all).
>
> §4's open question — "whether a longer wait would eventually have tripped the
> threshold is unproven" — can now be stated precisely: ECS clamps the
> bounded-percent threshold to a minimum of **three** failed tasks, so at
> `desiredCount: 1` the breaker needs three failed launches. Run 1 stopped
> after two, so the breaker was slow (roughly 25 minutes at that retry
> cadence), not inert. The automatic rollback in run 2 came from the
> deployment alarm, not the breaker.
>
> The implemented filter also differs from the proposal in §5: it is
> `{ $.status >= 500 }`, matching every 5xx access record (not only
> `/api/health`), and the alarm attached to the service is that same
> `Request5xx` alarm. The record's advice to prefer a deployment-time signal
> over retuning the slow alarms was followed.
>
> The 30-second answer in §11 remains accurate **for run 1**. The two-run
> answer is in [rollback-drill-2.md](rollback-drill-2.md) §8.

## 1. Scope and isolation

| Item | Value |
| --- | --- |
| Drill account | `293633790894`, `us-east-1` |
| Production account | `556890483680` — not touched |
| Stack | `UniBudgetStack`, drill-only |
| Public endpoint checked | `https://d2yjnxxylmxk9w.cloudfront.net/api/health` |
| Baseline | `v1.1.3`, commit `c9eb373`, task definition `:2`, digest `sha256:949cfcf8…` |
| Broken image | `v0.0.0-drill.1`, task definition `:3`, digest `sha256:6bf3b039…` |
| Broken change | `/api/health` returns HTTP 500; `/api/live` stays 200 |
| Cleanup | verified at 19:52:38Z; nothing billable remains |

The drill used the stack's own RDS instance, not a Supabase project. The
`supabaseHost` and `supabaseDatabase` context values were pointed at the RDS
instance, and the three `unibudget/supabase/*` secret slots held the RDS
administrator credential, the `unibudget_app` credential, and the regional RDS
CA bundle. The instance was created by the drill stack, held no production
data, and was unreachable from outside the VPC. No production database was
contacted. This is a documented deviation from the original runbook, not a
hidden substitution.

The broken image was built in a detached worktree at `v1.1.3` and pushed only
to the drill account's ECR repository. It was never committed, never tagged for
release, and never pushed to production.

## 2. Timeline (UTC, 2026-10-26)

| Time | Event |
| --- | --- |
| 19:11:37 | T0: `ecs update-service` to the broken revision `:3`. |
| 19:12:30 | Target registers as `initial`. |
| 19:12:31 | First failed readiness probe (`/api/health` 500, with a request id); `/api/live` stays 200. |
| 19:13:42 | Target declared unhealthy: `Health checks failed with these codes: [500]`. |
| 19:13:52 | First broken task stopped and deregistered. |
| 19:19:51 | Second broken task starts. |
| 19:21:43 | Second broken task declared unhealthy; stopped one second later. |
| 19:25:22 | **Explicit rollback** — `ecs update-service` to revision `:2`. |
| 19:30:04 | Deployment `COMPLETED`; steady state on revision `:2`. |
| 19:52:38 | Cleanup verified; no billable drill resource remains. |

Detection: **41 seconds** to the first failed probe; **1 minute 52 seconds** to
the `unhealthy` event. Recovery: **18 minutes 27 seconds** from T0 to steady
state. The `/api/health` endpoint through CloudFront returned 200 before,
during, and after the drill. `/login` and the blog routes were **not checked**
before cleanup.

## 3. Acceptance criteria

| Criterion | Required | Observed |
| --- | --- | --- |
| Detection latency | < 2 min from failed task start | **Pass** — 41 s to first failed probe, 1 m 52 s to `unhealthy` |
| Rollback without manual task-definition change | Yes | **Fail** — circuit breaker did not roll back; explicit `update-service` at 19:25:22Z |
| Restored digest equals baseline digest | Yes | **Pass** — `sha256:949cfcf8…` |
| `/api/health` returns 200 after recovery | Yes | **Pass** — 200 `{"status":"ok"}` |
| `/login` and blog route return expected status | Yes | **Not checked** — not measured before cleanup |
| No sustained 5xx beyond the probe window | Yes | **Pass (viewer side)** — 200 throughout; only ALB probes received 500 |
| Evidence timestamps in UTC | Yes | **Pass** |

**Verdict: partial pass.** Detection, traffic isolation, manual recovery, and
baseline restoration are proven. Automatic circuit-breaker rollback, alarm
detection, and the post-recovery login/blog checks are not.

## 4. Why the circuit breaker did not roll back

The observed behavior is in the runbook: with `minHealthyPercent: 100` and
`desiredCount: 1`, ECS kept the healthy baseline task and retried the broken
revision. The deployment stayed `IN_PROGRESS` with `failedTasks: 2` for about
14 minutes. It did not enter a failed state that triggered the circuit breaker.

The honest statement is:

> The circuit breaker was configured, but it did not roll back. ECS kept the
> healthy task and retried the broken revision; I rolled back explicitly after
> two failed task launches. Whether a longer wait would eventually have tripped
> the threshold is unproven, because I intervened.

This is a configuration interaction worth investigating: a single-task service
with `minHealthyPercent: 100` can preserve availability by keeping the old task
and retrying forever, which is good for viewers but bad for automatic
rollback. The next drill should record the failed-task count and let the
deployment reach its own terminal state before intervening.

## 5. Why no alarm fired

All four alarms stayed `OK`; `UnHealthyHostCount` recorded `0.0` for every
minute.

| Alarm | Metric | Why it stayed OK |
| --- | --- | --- |
| `Target5xx` | ALB `HTTPCode_Target_5XX_Count` | The ALB sent only health probes, not viewer traffic, and ELB does not count health-check requests in this metric at all; the count never rose, so no threshold was reachable. |
| `UnhealthyTargets` | ALB `UnHealthyHostCount` | ECS removed each failing target about one second after the first unhealthy report, so a 2 × 1-minute alarm window was never satisfied. |
| `LiveTaskCount` | ECS `LiveTaskCount` | A task was running throughout — first the baseline, then the broken retry. |
| `StructuredErrors` | Logs metric filter `{ $.level = "error" }` | The health 500 was a `warn` access record, not an `error` record; no exception was logged. |

This is a real observability gap. The four alarms cover **in-service** failures:
a running target returning 5xx, a registered target staying unhealthy for two
periods, capacity dropping, or an application exception. They do not cover a
**failed deployment before the new task can take traffic**, because the
readiness gate and ECS task replacement keep the failure out of the sustained
ALB metrics. The ECS deployment events and task logs detected it.

### Action item

Add a detection path that does not depend on sustained target registration. The
smallest useful change is a second CloudWatch Logs metric filter on the
application log group:

```text
{ $.path = "/api/health" && $.status = 500 }
```

with an alarm threshold of `> 0` for one period. That would have entered
`ALARM` at the end of the minute containing the first broken probe
(19:12:31Z) — about 30 seconds later, not on the probe itself, because an alarm
evaluates at period boundaries. An EventBridge rule on an ECS
deployment state change to `FAILED` is the more complete alternative, but it is
a larger change. This is **proposed, not applied**.

## 6. Contributing factors (no individuals)

- **The readiness gate worked as designed.** The broken task failed
  `/api/health` and never received viewer traffic; the `/api/health` endpoint
  stayed 200. That is the strongest positive result.
- **`minHealthyPercent: 100` plus one desired task preserved availability but
  prevented a terminal failed deployment.** ECS kept the healthy task and
  retried the broken revision. The circuit breaker had no failed deployment to
  act on.
- **The alarm design assumes sustained target registration.** ECS replaced the
  bad task within seconds, so `UnHealthyHostCount` never stayed nonzero for the
  two-period window.
- **5xx access records are `warn`, not `error`.** `StructuredErrors` therefore
  cannot catch a 500 response that does not throw.
- **The drill did not check `/login` or the blog routes.** Those post-recovery
  checks remain unmeasured.
- **The documentation was written before the drill.** The runbook has been
  updated; the Week 7 report, release-readiness page, chaos playbook, and final
  SDLC report still need a dated addendum.

## 7. What went well

- The drill ran in a separate AWS account; production was never targeted.
- The broken image was confined to the drill account and never released.
- Detection took 41 seconds to the first failed probe and 1m52s to `unhealthy`.
- No viewer traffic reached the broken task; `/api/health` stayed 200.
- The baseline task definition and digest were restored and verified.
- Cleanup was complete: no RDS, ECS, ECR, ALB, CloudFront, log group, secret,
  SNS topic, S3 bucket, alarm, or NAT gateway remained; total spend under $1.
- The evidence was captured before retention expired.

## 8. What made it worse

- The operator rolled back before the circuit breaker reached a terminal state,
  so the automatic path remains unproven.
- No alarm fired, so the notification path was not validated.
- `/login` and the blog routes were not checked after recovery.
- The runbook was updated, but the other reports still described the drill as
  unexecuted at the time of writing.

## 9. Action items

| # | Action | Priority | Evidence of completion |
| --- | --- | --- | --- |
| 1 | Add the `/api/health` 500 metric filter and alarm; test it with a container that returns 500. | High | CDK test + deployed alarm in `ALARM` during a drill |
| 2 | Investigate the `minHealthyPercent: 100` / desired-1 interaction and re-run the drill without manual intervention. Record the failed-task count and terminal state. | High | New execution record with `rollback without manual change = pass` |
| 3 | Re-run with `/login`, a real blog slug, and an unknown slug checked after recovery. | High | HTTP status table in the new record |
| 4 | Add a dated addendum to `week7-deliverables.md` §5, `release-readiness.md`, `chaos-drill.md`, and the final SDLC report; link this post-mortem. | High | Documents agree |
| 5 | Keep the RDS deviation and cleanup evidence in the record. | Medium | `cleanup-results.txt` |
| 6 | Define a proposed RPO (24 hours, bounded by the 02:15 UTC dump) and time a restore separately. | Medium | Timed restore log |
| 7 | Confirm inbox receipt of the SNS test message, or keep "unconfirmed" and stop treating delivery metrics as mailbox proof. | Low | Mailbox screenshot or explicit gap |

## 10. Evidence index

Curated evidence (safe to submit):

- [cleanup-results.txt](../drill-evidence/cleanup-results.txt)
- [cloudwatch-alarm-history.txt](../drill-evidence/cloudwatch-alarm-history.txt)
- [ecs-deployment-events.txt](../drill-evidence/ecs-deployment-events.txt)
- [health-check-results.txt](../drill-evidence/health-check-results.txt)
- [image-verification.txt](../drill-evidence/image-verification.txt)
- [git-evidence.txt](../drill-evidence/git-evidence.txt)

The raw `.drill-tmp/` and `.drill-worktree/` directories were removed during
cleanup and are not part of the submission.

## 11. The 30-second answer

> I ran Rollback Drill 2 in an isolated AWS account, not production. I deployed
> a drill-only image whose readiness endpoint returned 500. The load balancer
> never sent it viewer traffic, so `/api/health` through CloudFront stayed 200.
> ECS detected it in 1 minute 52 seconds and stopped it. I rolled back manually
> after two failed task launches, restored the baseline task definition and
> digest, and verified the endpoint. The drill proved detection, isolation, and
> manual recovery. It did not prove automatic circuit-breaker rollback, and no
> CloudWatch alarm fired, because ECS replaced the bad task before the
> unhealthy-target window and the health 500s stayed below the 5xx threshold.
> Those are the two gaps I would fix next. `/login` and the blog routes were not
> checked after recovery; that is the third gap.
