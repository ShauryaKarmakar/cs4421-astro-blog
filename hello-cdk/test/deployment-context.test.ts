import { resolveDeploymentAlarmName } from '../lib/deployment-context';

describe('resolveDeploymentAlarmName', () => {
  test('returns the alarm name for a deployment that starts tasks', () => {
    expect(
      resolveDeploymentAlarmName(1, 'UniBudgetStack-Monitoring-Request5xx'),
    ).toBe('UniBudgetStack-Monitoring-Request5xx');
  });

  test('refuses to start tasks without a deployment alarm', () => {
    expect(() => resolveDeploymentAlarmName(1, undefined)).toThrow(
      /deploymentAlarmName/,
    );
    expect(() => resolveDeploymentAlarmName(3, '')).toThrow(
      /deploymentAlarmName/,
    );
    // The message has to carry the recovery step, not only the missing value.
    expect(() => resolveDeploymentAlarmName(1, undefined)).toThrow(
      /UniBudgetStack-Monitoring/,
    );
  });

  test('allows the bootstrap path, which starts no tasks', () => {
    expect(resolveDeploymentAlarmName(0, undefined)).toBeUndefined();
  });

  test('keeps an explicitly supplied alarm even at zero tasks', () => {
    expect(
      resolveDeploymentAlarmName(0, 'UniBudgetStack-Monitoring-Request5xx'),
    ).toBe('UniBudgetStack-Monitoring-Request5xx');
  });

  test('rejects a name that cannot be a CloudWatch alarm', () => {
    expect(() => resolveDeploymentAlarmName(1, 'bad name')).toThrow(
      /valid CloudWatch alarm name/,
    );
    expect(() => resolveDeploymentAlarmName(1, 'arn:aws:cloudwatch:us-east-1:1:alarm:x')).toThrow(
      /valid CloudWatch alarm name/,
    );
  });
});
