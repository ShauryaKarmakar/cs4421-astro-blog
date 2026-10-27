/**
 * Deployment-context rules for the application stack entry point.
 *
 * The ECS service's automatic rollback depends on a CloudWatch alarm that is
 * owned by `UniBudgetStack-Monitoring`. That stack can only be deployed after
 * the application stack exists (it imports the log group, target group, and
 * SNS topic), so the alarm name cannot be a cross-stack reference. It is passed
 * as context instead, and this module makes the requirement explicit: a
 * deployment that starts tasks must name an alarm, so a rollout can never be
 * advertised as protected while ECS is watching nothing.
 */

export const DEPLOYMENT_ALARM_NAME_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * Returns the alarm name to attach to the service, or `undefined` when the
 * deployment starts no tasks.
 *
 * @throws if `desiredCount` is positive and no alarm name is supplied, or if
 * the supplied name is not a valid CloudWatch alarm name.
 */
export function resolveDeploymentAlarmName(
  desiredCount: number,
  contextValue: unknown,
): string | undefined {
  const provided =
    contextValue === undefined || contextValue === ''
      ? undefined
      : String(contextValue);

  if (provided !== undefined && !DEPLOYMENT_ALARM_NAME_PATTERN.test(provided)) {
    throw new Error('deploymentAlarmName must be a valid CloudWatch alarm name.');
  }

  if (desiredCount > 0 && provided === undefined) {
    throw new Error(
      'Missing required context value: deploymentAlarmName. Deploy ' +
        'UniBudgetStack-Monitoring first, then deploy this stack with ' +
        '-c deploymentAlarmName=UniBudgetStack-Monitoring-Request5xx so a ' +
        'failing rollout rolls back automatically.',
    );
  }

  return provided;
}
