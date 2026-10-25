# Production log analysis and incident correlation runbook

`src/lib/serverLogger.ts` writes one JSON object per line. The ECS task
definition sends both container streams (`stdout` and `stderr`, via the
`awslogs` driver) to the log group `/unibudget/ecs/application`, stream prefix
`application` (`migration` for one-off tasks). This document is the repeatable
path from an alarm or a user report to the exact request and error records.

Every field name here is part of the observability contract. Changing one
requires updating `hello-cdk/lib/monitoring-stack.ts` (the metric filter), the
CDK and logging tests, and `docs/adr/0009-cloudwatch-observability.md`.

## Verified deployment state

Checked read-only on 2026-10-25; re-check rather than assuming it still holds.

| Fact | Verified value |
| --- | --- |
| Log group | `/unibudget/ecs/application`, 7-day retention |
| Metric filter | `ApplicationErrorMetricFilter…` → `{ $.level = "error" }` on that group |
| Metric | `UniBudget/Application` `StructuredErrorCount`, value `1`, default `0` |
| Running release | task definition `UniBudgetStackApplicationTask3DB06674:4`, image tag `v1.1.3`, digest `sha256:168b26…` |
| Access records | present: a `{"level":"info","event":"http.request",…}` line with `requestId` was observed in the live log group |
| Alarms | the four `UniBudgetStack-Monitoring-*` alarms, all `OK`, each with the SNS topic as its action |

The release that introduced this schema is `v1.1.3`. The repository branch used
for the chaos-drill preparation now carries the same schema plus one
correction that is **not deployed yet**: an unhandled request failure answers a
generic `500` with `X-Request-Id` instead of rethrowing into the framework.
Until that is released, a 500 still gets its error and access records with a
shared `requestId`, but the browser response may not carry the header.

## Schema

| Field | Present on | Meaning |
| --- | --- | --- |
| `level` | all records | `info` (2xx/3xx), `warn` (4xx/5xx), `error` (exception) |
| `timestamp` | all records | ISO-8601 UTC, millisecond precision |
| `event` | all records | Stable event name, for example `http.request` |
| `requestId` | records written while serving a request | Correlation id, also returned as `X-Request-Id` |
| `method` | request-scoped records | HTTP method |
| `path` | request-scoped records | URL pathname only, never the query string; truncated to 512 characters, plus `...` when truncation occurs |
| `status` | access records | HTTP status returned to the caller |
| `durationMs` | access records | Integer milliseconds from middleware entry to response |
| `errorName` | error records | Error class name only (`Error`, `DatabaseError`, …) |
| `code` | error records, when present | Five-character SQLSTATE-style code, for example `23505` |

Deliberately absent: request bodies, query strings, cookies, authorization
headers, session tokens, SQL text, email addresses, user ids, amounts, error
messages, and stack traces. Do not add them to make a single incident easier to
debug; use the `requestId` and the database's own metrics instead.

## Example records

```json
{"level":"info","timestamp":"2026-10-25T21:17:32.182Z","event":"http.request","requestId":"3f0c1f0e-6f1a-4d2b-9a4e-1c2b3d4e5f60","method":"GET","path":"/login","status":200,"durationMs":14}
{"level":"error","timestamp":"2026-10-25T16:02:36.418Z","event":"health.database.failed","errorName":"Error","code":"08006","requestId":"9a5b…","method":"GET","path":"/api/health"}
```

A readiness failure looks like the second line plus a `warn` access record for
`/api/health` with `status: 503`, while `/api/live` continues to log
`status: 200`. That pair is the evidence that the process is alive and the
dependency is not.

## First, confirm the schema you are querying

A field in a query that the application never writes returns nothing and looks
like "no errors". Confirm the live shape before trusting a filter:

```
fields @timestamp, level, event, requestId, method, path, status
| sort @timestamp desc
| limit 5
```

or, without the console:

```bash
export MSYS_NO_PATHCONV=1   # Git Bash rewrites leading slashes otherwise
aws logs filter-log-events \
  --log-group-name "/unibudget/ecs/application" \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --limit 5 --query 'events[].message' --output text
```

If the lines are JSON containing `level` and `requestId`, the queries below
apply. If they are framework stack traces instead, the running image predates
`v1.1.3` and should be identified before any conclusion is drawn.

## Workflow: from alarm to log lines

1. **Identify the time window.** Open the alarm in CloudWatch and note the
   transition to `ALARM`, not the time the email arrived. Add five minutes
   before the transition to catch the trigger.
2. **Confirm what changed.** Check whether an ECS deployment started in the
   window:

   ```bash
   aws ecs describe-services \
     --cluster UniBudgetStack-ApplicationClusterC783CD56-hXQUSkONBCXV \
     --services UniBudgetStack-ApplicationService423C69C6-YCFTDtV8bRhX \
     --query 'services[0].events[0:10].[createdAt,message]' --output table
   ```

3. **Count the failures by route.** Logs Insights on `/unibudget/ecs/application`:

   ```
   fields @timestamp, requestId, method, path, status, durationMs
   | filter event = "http.request" and status >= 500
   | stats count() as failures, max(durationMs) as slowest by path
   | sort failures desc
   ```

4. **Pick one `requestId` and read the whole story for it.**

   ```
   fields @timestamp, level, event, method, path, status, durationMs, errorName, code
   | filter requestId = "3f0c1f0e-6f1a-4d2b-9a4e-1c2b3d4e5f60"
   | sort @timestamp asc
   ```

   The access record gives method, route, status, and latency; the error record
   gives the exception class and SQLSTATE. A SQLSTATE beginning with `42` is a
   schema or permission error (a migration that did not run), `08` is a
   connection failure, and `23` is a constraint violation.
5. **Check whether it is one route or all routes.** Group the error records by
   `path`, `event`, `errorName`, and `code`. All routes failing together points
   at the database, the role gate, or the security group; one route failing
   points at that route's code.
6. **Check liveness separately.** `/api/live` records must stay `200` during a
   database outage. If `/api/live` also fails, the task is genuinely unhealthy
   and ECS will replace it; if only `/api/health` fails, the target is removed
   from the load balancer but the process is not restarted.
7. **Compare with the running artifact.** Confirm the task uses the expected
   image before drawing conclusions about the code:

   ```bash
   aws ecs describe-tasks \
     --cluster UniBudgetStack-ApplicationClusterC783CD56-hXQUSkONBCXV \
     --tasks <task-id> \
     --query 'tasks[0].containers[0].{image:image,digest:imageDigest}'
   ```

8. **Record the result.** Note the window, the affected `path` values, one
   representative `requestId`, the release digest, and the action taken. The
   `requestId` is the durable link between the alarm and the log lines.

## Useful saved queries

| Question | Query |
| --- | --- |
| Recent server errors | `fields @timestamp, event, errorName, code, requestId, path \| filter level = "error" \| sort @timestamp desc \| limit 50` |
| Errors grouped by route and classification | `fields @timestamp, event, errorName, code, path \| filter level = "error" \| stats count() as errors by path, event, errorName, code \| sort errors desc` |
| One request end to end | `fields @timestamp, level, event, method, path, status, durationMs, errorName, code \| filter requestId = "<id>" \| sort @timestamp asc` |
| 5xx responses | `fields @timestamp, requestId, path, status, durationMs \| filter event = "http.request" and status >= 500 \| sort @timestamp desc \| limit 100` |
| 5xx per minute | `fields @timestamp, status \| filter event = "http.request" and status >= 500 \| stats count() as failures by bin(1m) \| sort @timestamp asc` |
| Activity around a reported incident | `fields @timestamp, level, event, requestId, method, path, status, durationMs \| filter @timestamp >= "2026-10-25T21:00:00.000Z" and @timestamp <= "2026-10-25T21:15:00.000Z" \| sort @timestamp asc \| limit 200` |
| Slowest routes | `fields @timestamp, method, path, status, durationMs \| filter event = "http.request" \| stats avg(durationMs), max(durationMs), count() by path \| sort max(durationMs) desc` |
| Traffic and status mix | `fields @timestamp, status \| filter event = "http.request" \| stats count() by status` |
| Readiness failures | `fields @timestamp, requestId, path, status \| filter event = "http.request" and path = "/api/health" and status >= 500 \| sort @timestamp desc \| limit 20` |
| Probe noise | `fields @timestamp, path, status, durationMs \| filter event = "http.request" and path in ["/api/health","/api/live"] \| stats count(), max(durationMs) by path` |
| Migration outcome | `fields @timestamp, level, event, errorName, code \| filter @logStream like /migration/ \| sort @timestamp desc \| limit 50` |

## Finding the surrounding evidence

| What | Command or location |
| --- | --- |
| Log group | `aws logs describe-log-groups --log-group-name-prefix "/unibudget"` |
| Metric filter | `aws logs describe-metric-filters --log-group-name "/unibudget/ecs/application"` |
| The four alarms and states | `aws cloudwatch describe-alarms --alarm-name-prefix UniBudgetStack-Monitoring- --query 'MetricAlarms[].{Name:AlarmName,State:StateValue,Actions:AlarmActions}'` |
| Alarm history and actions | `aws cloudwatch describe-alarm-history --alarm-name UniBudgetStack-Monitoring-StructuredErrors --max-records 20` (repeat per alarm) |
| ECS service and deployment events | `aws ecs describe-services --cluster <cluster> --services <service> --query 'services[0].{desired:desiredCount,running:runningCount,taskDef:taskDefinition,deployments:deployments,events:events[0:20]}'` |
| Task stop reason | `aws ecs describe-tasks --cluster <cluster> --tasks <task-id> --query 'tasks[0].{lastStatus:lastStatus,stopCode:stopCode,stoppedReason:stoppedReason,containers:containers[].[name,exitCode,reason]}'` |
| ALB target health | `aws elbv2 describe-target-health --target-group-arn <target-group-arn>` (find it with `aws elbv2 describe-target-groups --names UniBud-Appli-S7VNWXHA2XLE`) |
| Release revision and image | `aws ecs describe-task-definition --task-definition UniBudgetStackApplicationTask3DB06674 --query 'taskDefinition.[revision,containerDefinitions[0].image]'` |

## Record these before acting

Write them into the incident note first; they are the evidence the drill is
assessed on:

1. UTC time you first observed the symptom, and the alarm transition time.
2. Failing URL/path and HTTP status (with the `X-Request-Id` header if present).
3. `requestId` from the response header or the access record.
4. Alarm name(s) and state at the time (`OK`, `ALARM`, `INSUFFICIENT_DATA`).
5. Running task definition revision and image digest.
6. Recovery evidence: first `200` after the fix, its timestamp, and the
   revision/digest serving it.

## Limits and known gaps

- A request that crashes the Node process, or that is rejected by the adapter
  before the middleware, leaves no access record; use ECS service events and
  the `LiveTaskCount` alarm for that case.
- Health probes generate roughly four records per minute per task (ALB
  readiness every 30 s, container liveness every 30 s). That is the expected
  baseline, not an incident.
- An unhandled failure produces one `error` record and one `warn` access
  record for the same `requestId`. That is intentional; it is not a
  double-count, because only `level = "error"` increments
  `StructuredErrorCount`.
- `awslogs` adds its own timestamp to each event; the record's `timestamp`
  field is the application's clock. Use `@timestamp` for ordering and the
  field for request-level latency.
- Log retention is seven days (`logs.RetentionDays.ONE_WEEK`). Export a window
  with `aws logs create-export-task` before investigating anything older.
- A 5xx that is returned without an exception (for example the readiness probe
  answering `503`) has no `error` record and does not increment
  `StructuredErrorCount`; it is visible in the access records and in the ALB
  and unhealthy-target alarms instead.
