import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflow = readFileSync(
  resolve(projectRoot, '.github/workflows/deploy.yml'),
  'utf8',
).replace(/\r\n/g, '\n');

function stepBlock(name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`The deployment workflow does not define the ${name} step.`);
  }

  const next = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

describe('deployment workflow contracts', () => {
  it('reads the task, role, and secret outputs used by validation', () => {
    const outputs = stepBlock('Read Stack Outputs');
    const expectedOutputs = {
      application_task_definition: 'TaskDefinitionArn',
      application_task_role_arn: 'ApplicationTaskRoleArn',
      application_task_execution_role_arn: 'ApplicationTaskExecutionRoleArn',
      migration_task_definition: 'MigrationTaskDefinitionArn',
      migration_task_role_arn: 'MigrationTaskRoleArn',
      migration_task_execution_role_arn: 'MigrationTaskExecutionRoleArn',
      supabase_application_secret_arn: 'SupabaseApplicationSecretArn',
      supabase_migration_secret_arn: 'SupabaseMigrationSecretArn',
      supabase_ca_secret_arn: 'SupabaseCaSecretArn',
    };

    for (const [key, outputName] of Object.entries(expectedOutputs)) {
      expect(outputs).toContain(
        `echo "${key}=$(output_value ${outputName})"`,
      );
    }
  });

  it('validates exact task and execution role ARNs for both task definitions', () => {
    const validation = stepBlock('Validate Migration Task Configuration');

    expect(validation).toContain(
      'APPLICATION_TASK_ROLE_ARN: ${{ steps.outputs.outputs.application_task_role_arn }}',
    );
    expect(validation).toContain(
      'APPLICATION_TASK_EXECUTION_ROLE_ARN: ${{ steps.outputs.outputs.application_task_execution_role_arn }}',
    );
    expect(validation).toContain(
      'MIGRATION_TASK_ROLE_ARN: ${{ steps.outputs.outputs.migration_task_role_arn }}',
    );
    expect(validation).toContain(
      'MIGRATION_TASK_EXECUTION_ROLE_ARN: ${{ steps.outputs.outputs.migration_task_execution_role_arn }}',
    );
    expect(validation).toContain('require_role_arn');
    expect(validation).toContain('"application task role"');
    expect(validation).toContain('"application task execution role"');
    expect(validation).toContain('"migration task role"');
    expect(validation).toContain('"migration task execution role"');
    expect(validation).toContain(
      'aws ecs describe-task-definition \\\n            --task-definition "$APPLICATION_TASK_DEFINITION"',
    );
    expect(validation).toContain(
      'aws ecs describe-task-definition \\\n            --task-definition "$MIGRATION_TASK_DEFINITION"',
    );
  });

  it('validates exact secret ARNs instead of substring matches', () => {
    const validation = stepBlock('Validate Migration Task Configuration');

    expect(validation).toContain('require_exact_secret');
    expect(validation).toContain(
      'require_exact_secret PGUSER "$SUPABASE_MIGRATION_SECRET_ARN"',
    );
    expect(validation).toContain(
      'require_exact_secret PGPASSWORD "$SUPABASE_MIGRATION_SECRET_ARN"',
    );
    expect(validation).toContain(
      'require_exact_secret APP_DATABASE_PASSWORD "$SUPABASE_APPLICATION_SECRET_ARN"',
    );
    expect(validation).toContain(
      'require_exact_secret SUPABASE_CA_CERT "$SUPABASE_CA_SECRET_ARN"',
    );
    expect(validation).toContain('"$expected"|"$expected":*::');
    expect(validation).not.toContain('contains($needle)');
  });

  it('checks the application DNS target before building or migrating', () => {
    const dnsStepIndex = workflow.indexOf(
      '      - name: Verify Application DNS Target\n',
    );
    const buildStepIndex = workflow.indexOf(
      '      - name: Build and Push Application Image\n',
    );
    const migrationStepIndex = workflow.indexOf(
      '      - name: Run the One-Off Migration Task\n',
    );

    expect(dnsStepIndex).toBeGreaterThan(-1);
    expect(dnsStepIndex).toBeLessThan(buildStepIndex);
    expect(dnsStepIndex).toBeLessThan(migrationStepIndex);

    const dnsStep = stepBlock('Verify Application DNS Target');
    expect(dnsStep).toContain('if: inputs.bootstrapOnly != true');
    expect(dnsStep).toContain(
      'LOAD_BALANCER_DNS: ${{ steps.outputs.outputs.load_balancer_dns }}',
    );
    expect(dnsStep).toContain('getent ahostsv4 "$app_host"');
    expect(dnsStep).toContain('getent ahostsv4 "$LOAD_BALANCER_DNS"');
    expect(dnsStep).toContain('grep -Fxq "$ip"');
    expect(dnsStep).toContain('exit 1');
  });
});
