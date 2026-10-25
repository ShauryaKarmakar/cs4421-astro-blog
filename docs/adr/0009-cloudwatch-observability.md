# 0009 — Structured logs, metric filter, and actionable alarms

- Status: Accepted
- Date: 2026-10-25

## Context

CloudWatch logs are useful only if errors can be queried and an operator is
notified. An alarm with no action is a console decoration. The application has
one ECS service, an ALB target group, and a small number of high-signal
failure modes.

## Decision

- Application errors are written as one JSON object per line to stderr, using
  only `level`, `event`, `errorName`, and an optional AWS error `code`. No
  credentials, SQL, session tokens, or user data are logged.
- A CloudWatch Logs metric filter matches `{ $.level = "error" }` and
  publishes `UniBudget/Application/StructuredErrorCount`.
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

## Consequences

- Without an SNS topic and a confirmed subscription, alarms change state but
  notify nobody. This is an explicit deployment prerequisite, not a working
  notification path.
- The metric filter is valid only while the structured log schema remains
  stable; changing `level` requires updating the filter and tests.
- Thresholds are tuned for a single-task service. A higher desired count
  changes the task-count threshold automatically.
- Deployment and startup can produce transient 5xx or missing datapoints;
  `notBreaching` is used where appropriate, while task count treats missing
  data as breaching.
