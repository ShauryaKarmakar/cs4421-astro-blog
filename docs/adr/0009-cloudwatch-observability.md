# 0009 — Structured logs, metric filter, and actionable alarms

- Status: Accepted
- Date: 2026-10-25
- Amended: 2026-10-25 — request-scoped access records and correlation ids
- Amended: 2026-10-25 — monitoring moved to `UniBudgetStack-Monitoring`

## Context

CloudWatch logs are useful only if errors can be queried and an operator is
notified. An alarm with no action is a console decoration. The application has
one ECS service, an ALB target group, and a small number of high-signal
failure modes.

Before the logging amendment, the application wrote an error-only record
containing `level`, `event`, `errorName`, and an optional SQLSTATE `code`. It
recorded no timestamp, route, method, status, latency, or correlation id, so a
production 5xx could not be tied to the request that caused it: CloudWatch
showed a stack trace from the framework and no request context at all.

Alarms and the application error metric filter were originally defined inline
in the application stack. That mixed two ownership boundaries: an alarm change
forced an ECS/ECR/IAM stack update, and the same definitions existed in a second
implementation at the same time. They now live in the dedicated
`UniBudgetStack-Monitoring` stack.

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
- One CloudWatch Logs metric filter matches `{ $.level = "error" }` and
  publishes `UniBudget/Application/StructuredErrorCount`. Because access
  records use `warn` for 5xx, one failed request increments the metric once
  (its exception record), not twice.
- Four alarms are owned by `hello-cdk/lib/monitoring-stack.ts`, deployed as the
  `UniBudgetStack-Monitoring` stack: target 5xx count, unhealthy targets, live
  task count below the desired count, and structured error count. Their names
  are prefixed `UniBudgetStack-Monitoring-`, their thresholds are
  `GreaterThanThreshold` 5, `GreaterThanThreshold` 0, `LessThanThreshold`
  `desiredCount`, and `GreaterThanThreshold` 5, and missing data is
  `notBreaching` except for the task-count alarm, which is `breaching`.
- The monitoring stack creates no ECS, ECR, IAM, log-group, or SNS resources.
  It imports the existing log group, the ALB and target-group dimension values,
  the cluster and service names, and the operator-managed SNS topic. The
  application stack defines neither an alarm nor a metric filter, and its tests
  assert that absence.
- `LiveTaskCount` is used for task availability because it is published for a
  standard ECS service. `RunningTaskCount` requires Container Insights, which
  this service does not enable, so that metric would never produce a datapoint.
- The monitoring stack always creates the task-count alarm and therefore
  requires a positive `desiredCount`. The application stack's zero-count
  bootstrap does not create monitoring resources; the monitoring stack is a
  separate, explicitly approved deployment.
- The monitoring stack attaches the existing SNS topic through `alarmTopicArn`.
  It never creates a topic or invents a subscription address.

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
- **Keeping the alarms inline in the application stack** — rejected. The
  application change set also carried ECS, task-definition, and IAM changes
  caused by the ECR repository reference, and a second copy already existed in
  the monitoring stack; both copies would have created duplicate alarms and a
  second metric filter for the same log events.
- **`RunningTaskCount` for task availability** — rejected; without Container
  Insights the metric has no datapoints, so an alarm on it cannot distinguish a
  healthy service from a missing one.

## Consequences

- An application release no longer creates or modifies alarms or the metric
  filter, and cannot silently duplicate `StructuredErrorCount`.
- Exactly one stack defines the monitoring resources. Adding an alarm to
  `cdk-stack.ts` again would recreate the duplicate-alarm and doubled-metric
  failure this decision removed; the application stack test fails if one is
  reintroduced.
- Monitoring changes require their own diff and approval. The stack imports
  resources instead of owning them, so it cannot update ECS, ECR, IAM, the log
  group, or the SNS topic.
- The `level` field and the `event` names are part of the metric-filter and
  runbook contract. Renaming either requires updating
  `hello-cdk/lib/monitoring-stack.ts`, the CDK tests, and `docs/logging.md`.
- Log volume grows by roughly four records per minute per task from the ALB and
  container health probes. At one task and seven-day retention this is small,
  and the probes remain useful as an independent record of readiness state.
- Redirects are `warn`, not `error`; a storm of 302s is visible but does not
  trip the error metric.
- `warn` records are not counted by the structured-error alarm. A 5xx response
  that is generated without an exception (for example by the framework's error
  page) is caught by the target-5xx alarm instead.
- Without a confirmed subscription on the SNS topic, alarms change state but
  notify nobody. The topic and a confirmed subscription are deployment
  prerequisites, not something either stack creates.
- Requests that fail before the middleware completes (for example an adapter
  crash) have no access record; liveness failures are observed through the ECS
  service events and the task-count alarm.
- Thresholds are tuned for a single-task service. A higher desired count raises
  the task-count threshold automatically through the `desiredCount` context
  value, but the 5xx and error thresholds must be reviewed if traffic grows.
