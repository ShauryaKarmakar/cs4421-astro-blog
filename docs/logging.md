# Production log analysis runbook

`src/lib/serverLogger.ts` writes one JSON object per line. The ECS task
definition sends both container streams (`stdout` and `stderr`, via the
`awslogs` driver) to the log group `/unibudget/ecs/application`, stream prefix
`application` (`migration` for one-off tasks). This document is the repeatable
path from an alarm or a user report to the exact request and error records.

Every field name here is part of the observability contract. Changing one
requires updating `hello-cdk/lib/cdk-stack.ts` (the metric filter), the CDK
tests, and `docs/adr/0009-cloudwatch-observability.md`.

## Schema

| Field | Present on | Meaning |
| --- | --- | --- |
| `level` | all records | `info` (success), `warn` (4xx/5xx/redirect), `error` (exception) |
| `timestamp` | all records | ISO-8601 UTC, millisecond precision |
| `event` | all records | Stable event name, for example `http.request`, `health.database.failed` |
| `requestId` | records written while serving a request | Correlation id, also returned as `X-Request-Id` |
| `method` | request-scoped records | HTTP method |
| `path` | request-scoped records | URL pathname only, never the query string; capped at 512 characters |
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
{"level":"info","timestamp":"2026-10-25T16:02:36.412Z","event":"http.request","requestId":"3f0c1f0e-6f1a-4d2b-9a4e-1c2b3d4e5f60","method":"GET","path":"/blog/first-post","status":200,"durationMs":14}
{"level":"error","timestamp":"2026-10-25T16:02:36.418Z","event":"health.database.failed","errorName":"Error","code":"08006","requestId":"9a5b...","method":"GET","path":"/api/health"}
```

The readiness probe failing looks like the second line plus a `warn` access
record for `/api/health` with `status: 503`, while `/api/live` continues to log
`status: 200`. That pair is the evidence that the process is alive and the
dependency is not.

## Workflow: from alarm to log lines

1. **Identify the time window.** Open the alarm in CloudWatch and note the
   transition to `ALARM`, not the time the email arrived. Add five minutes
   before the transition to catch the trigger.
2. **Confirm what changed.** Check whether an ECS deployment started in the
   window:

   ```bash
   aws ecs describe-services --cluster <cluster> --services <service> \
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
5. **Check whether it is one route or all routes.** Filter the error records by
   `path` and by `errorName`. All routes failing together points at the
   database, the role gate, or the security group; one route failing points at
   that route's code.
6. **Check liveness separately.** `/api/live` records must stay `200` during a
   database outage. If `/api/live` also fails, the task is genuinely unhealthy
   and ECS will replace it; if only `/api/health` fails, the target is removed
   from the load balancer but the process is not restarted.
7. **Compare with the running artifact.** Confirm the task uses the expected
   image digest before drawing conclusions about the code:

   ```bash
   aws ecs describe-tasks --cluster <cluster> --tasks <task> \
     --query 'tasks[0].containers[0].imageDigest' --output text
   ```

8. **Record the result.** Note the window, the affected `path` values, one
   representative `requestId`, the release digest, and the action taken in the
   incident record. The `requestId` is the durable link between the alarm and
   the log lines.

## Useful saved queries

| Question | Query |
| --- | --- |
| Recent server errors | `fields @timestamp, event, errorName, code, requestId, path \| filter level = "error" \| sort @timestamp desc \| limit 50` |
| Slowest routes | `fields @timestamp, method, path, status, durationMs \| filter event = "http.request" \| stats avg(durationMs), max(durationMs), count() by path \| sort max(durationMs) desc` |
| Traffic and status mix | `fields @timestamp, status \| filter event = "http.request" \| stats count() by status` |
| Readiness failures | `fields @timestamp, requestId, path, status \| filter event = "http.request" and path = "/api/health" and status >= 500 \| sort @timestamp desc \| limit 20` |
| Probe noise | `fields @timestamp, path, status, durationMs \| filter event = "http.request" and path in ["/api/health","/api/live"] \| stats count(), max(durationMs) by path` |
| Migration outcome | `fields @timestamp, level, event, errorName, code \| filter @logStream like /migration/ \| sort @timestamp desc \| limit 50` |

## Limits and known gaps

- The deployed `v1` image predates this schema, so production logs still show
  framework stack traces with no `requestId`, `method`, `path`, `status`, or
  `durationMs`. The queries above become effective only after a release built
  from the current branch is deployed.
- `awslogs` adds its own timestamp to each event; the record's `timestamp` field
  is the application's clock. Use `@timestamp` for ordering and the field for
  request-level latency.
- Log retention is seven days (`logs.RetentionDays.ONE_WEEK`). Export a window
  with `aws logs create-export-task` before investigating anything older.
- The access record is written after the response object exists. A request that
  crashes the Node process, or that is rejected by the adapter before
  middleware, leaves no access record; use ECS service events and the
  `RunningTaskCountAlarm` for that case.
