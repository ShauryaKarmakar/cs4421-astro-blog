# 0009 — Structured logs, metric filter, and actionable alarms

- Status: Accepted
- Date: 2026-10-25
- Amended: 2026-10-25 — request-scoped access records and correlation ids

## Context

CloudWatch logs are useful only if errors can be queried and an operator is
notified. An alarm with no action is a console decoration. The application has
one ECS service, an ALB target group, and a small number of high-signal
failure modes.

Before this amendment, the application wrote an error-only record containing
`level`, `event`, `errorName`, and an optional SQLSTATE `code`. It recorded no
timestamp, route, method, status, latency, or correlation id, so a production
5xx could not be tied to the request that caused it: CloudWatch showed a stack
trace from the framework and no request context at all.

## Decision

- Every HTTP request produces one JSON access record on stdout, written by the
  middleware after the response is created:

  ```json
  {"level":"info","timestamp":"2026-10-25T16:02:36.412Z","event":"http.request",
   "requestId":"3f0c…","method":"GET","path":"/blog/first-post","status":200,"durationMs":14}
  ```

- Server-side failures produce one JSON error record on stderr, as before, now
  with a timestamp and the same correlation fields:

  ```json
  {"level":"error","timestamp":"2026-10-25T16:02:36.412Z","event":"health.database.failed",
   "errorName":"Error","code":"08006","requestId":"3f0c…","method":"GET",
   "path":"/api/health"}
  ```

- `level` has three values: `info` for a successful request, `warn` for a 4xx,
  5xx, or redirect response, and `error` for an exception record. A 5xx request
  therefore produces a `warn` access record **and** an `error` exception record
  with the same `requestId`, which is what makes the failure diagnosable.
- `requestId` is taken from a caller-supplied `X-Request-Id` only when it is
  8–64 characters of `[A-Za-z0-9._-]`; otherwise a UUID is generated. The value
  is returned in the `X-Request-Id` response header, so an observed failure can
  be matched to its log lines.
- Correlation state is carried in `AsyncLocalStorage`, so every existing
  `logServerError(event, error)` call site attaches the request fields without
  changing its signature, and concurrent requests cannot mix context.
- The record schema is deliberately limited to the fields above. No
  credentials, cookies, authorization headers, query strings, request bodies,
  SQL text, user ids, email addresses, or amounts are logged. Paths are capped
  at 512 characters. Error messages and stack traces are never serialized; only
  the error class name and a five-character SQLSTATE-style code are kept.
- A CloudWatch Logs metric filter matches `{ $.level = "error" }` and publishes
  `UniBudget/Application/StructuredErrorCount`. Because access records use
  `warn` for 5xx, one failed request increments the metric once (its exception
  record), not twice.
- Four alarms cover target 5xx count, unhealthy targets, running task count
  below the desired count, and structured error rate. Thresholds and
  missing-data behavior are defined in `hello-cdk/lib/cdk-stack.ts`.
- The task-count alarm is omitted while `desiredCount` is 0 so a deliberate
  bootstrap does not alarm.
- The stack can attach an existing, operator-managed SNS topic through
  `alarmTopicArn`/`ALARM_TOPIC_ARN`. It never creates a topic or invents a
  subscription address.

## Alternatives considered

- **No alarms** — rejected; detection would remain manual.
- **A stack-created SNS topic with an email parameter** — rejected because an
  unconfirmed subscription is not reliable and would bake an address into
  infrastructure configuration.
- **One alarm per metric with no runbook** — rejected as noise; the four
  selected alarms map to distinct operator actions.
- **A third-party logging library** — rejected; the schema is small, the
  platform already ships JSON to CloudWatch, and a dependency would need its own
  redaction guarantees. `AsyncLocalStorage` and `JSON.stringify` are built in.
- **Logging request bodies or query strings** — rejected; they can contain
  credentials and financial data, and they are not needed to triage a route.
- **One `level: "error"` record per 5xx response** — rejected; it would double
  the `StructuredErrorCount` metric and make the alarm threshold meaningless.

## Consequences

- Log volume grows by roughly four records per minute per task from the ALB and
  container health probes. At one task and seven-day retention this is small,
  and the probes remain useful as an independent record of readiness state.
- The `level` field and the `event` names are part of the metric-filter and
  runbook contract. Renaming either requires updating
  `hello-cdk/lib/cdk-stack.ts`, the CDK tests, and `docs/logging.md`.
- Redirects are `warn`, not `error`; a storm of 302s is visible but does not
  trip the error metric.
- `warn` records are not counted by the structured-error alarm. A 5xx response
  that is generated without an exception (for example by the framework's error
  page) is caught by `Target5xxAlarm` instead.
- Without an SNS topic and a confirmed subscription, alarms change state but
  notify nobody. This is an explicit deployment prerequisite, not a working
  notification path.
- Requests that fail before the middleware completes (for example an adapter
  crash) have no access record; liveness failures are observed through the ECS
  service events and the running-task alarm.
