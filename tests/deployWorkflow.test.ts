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

  it('verifies CloudFront delivery before building or migrating', () => {
    const cloudFrontStepIndex = workflow.indexOf(
      '      - name: Verify CloudFront Delivery Configuration\n',
    );
    const buildStepIndex = workflow.indexOf(
      '      - name: Build and Push Application Image\n',
    );
    const migrationStepIndex = workflow.indexOf(
      '      - name: Run the One-Off Migration Task\n',
    );

    expect(cloudFrontStepIndex).toBeGreaterThan(-1);
    expect(cloudFrontStepIndex).toBeLessThan(buildStepIndex);
    expect(cloudFrontStepIndex).toBeLessThan(migrationStepIndex);

    const cloudFrontStep = stepBlock('Verify CloudFront Delivery Configuration');
    expect(cloudFrontStep).toContain('if: inputs.bootstrapOnly != true');
    expect(cloudFrontStep).toContain(
      'DISTRIBUTION_ID: ${{ steps.outputs.outputs.cloudfront_distribution_id }}',
    );
    expect(cloudFrontStep).toContain(
      'LOAD_BALANCER_DNS: ${{ steps.outputs.outputs.load_balancer_dns }}',
    );
    expect(cloudFrontStep).toContain('cloudfront get-distribution-config');
    expect(cloudFrontStep).toContain('.Origins[0].DomainName');
    expect(cloudFrontStep).toContain('"redirect-to-https"');
    expect(cloudFrontStep).toContain(
      '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
    );
    expect(cloudFrontStep).toContain(
      '216adef6-5c7f-47e4-b989-5492eafa07d3',
    );
    expect(cloudFrontStep).toContain('DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT');
    expect(cloudFrontStep).toContain('exit 1');
  });

  it('uses the derived CloudFront outputs as the only public HTTPS URL', () => {
    const outputs = stepBlock('Read Stack Outputs');
    expect(outputs).toContain(
      'application_url=$(output_value ApplicationUrl)',
    );
    expect(outputs).toContain(
      'echo "cloudfront_distribution_id=$(output_value CloudFrontDistributionId)"',
    );
    expect(outputs).toContain(
      'echo "cloudfront_domain_name=$cloudfront_domain"',
    );
    expect(outputs).toContain('https://$cloudfront_domain');

    expect(workflow).not.toContain('CERTIFICATE_ARN: ${{ vars.');
    expect(workflow).not.toContain('APPLICATION_URL: ${{ vars.');
    expect(workflow).not.toContain('aws acm describe-certificate');
    expect(workflow).not.toContain('-c certificateArn');
    expect(workflow).not.toContain('-c applicationUrl');

    const health = stepBlock('Verify Application Health Through CloudFront');
    expect(health).toContain(
      'APPLICATION_URL: ${{ steps.outputs.outputs.application_url }}',
    );
    expect(health).toContain('https://[a-z0-9]+\\.cloudfront\\.net');
    expect(health).toContain('/api/health');
  });

  it('restricts the load balancer to the CloudFront origin-facing prefix list', () => {
    expect(workflow).toContain('com.amazonaws.global.cloudfront.origin-facing');
    expect(workflow).toContain(
      '-c cloudFrontOriginPrefixListId="$ORIGIN_PREFIX_LIST"',
    );
    expect(workflow).toContain(
      'ORIGIN_PREFIX_LIST: ${{ steps.prerequisites.outputs.origin_prefix_list }}',
    );
    expect(workflow).not.toContain('getent ahostsv4');
  });

  it('requires a confirmed recovery plan before migrating', () => {
    expect(workflow).toContain('recoveryPlanVerified:');
    const validation = stepBlock('Validate Deployment Inputs');
    expect(validation).toContain('inputs.recoveryPlanVerified');
    expect(validation).toContain('restorable Supabase backup');
  });

  it('keeps the safe deployment order', () => {
    const names = [
      'Validate Deployment Inputs',
      'Create the Initial Stack Without Starting the Application',
      'Read Stack Outputs',
      'Verify CloudFront Delivery Configuration',
      'Build and Push Application Image',
      'Validate Migration Task Configuration',
      'Run the One-Off Migration Task',
      'Deploy the Stack with the Migrated Image',
      'Wait for the ECS Service',
      'Verify the Running Image',
      'Verify Application Health Through CloudFront',
    ];
    const positions = names.map((name) =>
      workflow.indexOf(`      - name: ${name}\n`),
    );

    expect(positions.every((index) => index > -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('validates the application task definition before migrating', () => {
    const validation = stepBlock('Validate Migration Task Configuration');

    expect(validation).toContain('ApplicationContainer');
    expect(validation).toContain(
      'expected_app_environment="HOST NODE_ENV PGDATABASE PGHOST PGPORT PGSSLMODE PORT"',
    );
    expect(validation).toContain('require_app_environment PGSSLMODE verify-full');
    expect(validation).toContain(
      'expected_app_secrets="PGPASSWORD PGUSER SUPABASE_CA_CERT"',
    );
    expect(validation).toContain(
      "require_app_secret PGUSER \"$SUPABASE_APPLICATION_SECRET_ARN\" ':username::'",
    );
    expect(validation).toContain(
      "require_app_secret PGPASSWORD \"$SUPABASE_APPLICATION_SECRET_ARN\" ':password::'",
    );
    expect(validation).toContain(
      "require_app_secret SUPABASE_CA_CERT \"$SUPABASE_CA_SECRET_ARN\" ''",
    );
    expect(validation).toContain('environmentFiles');
    expect(validation).toContain('DATABASE_URL$');
  });

  it('verifies origin delivery through CloudFront before building the image', () => {
    const cloudFrontStep = stepBlock('Verify CloudFront Delivery Configuration');
    const buildStepIndex = workflow.indexOf(
      '      - name: Build and Push Application Image\n',
    );
    const originCheckIndex = workflow.indexOf('login_https_url=');

    expect(originCheckIndex).toBeGreaterThan(-1);
    expect(originCheckIndex).toBeLessThan(buildStepIndex);
    expect(cloudFrontStep).toContain(
      'CLUSTER: ${{ steps.outputs.outputs.cluster }}',
    );
    expect(cloudFrontStep).toContain(
      'SERVICE: ${{ steps.outputs.outputs.service }}',
    );
    expect(cloudFrontStep).toContain('aws ecs describe-services');
    expect(cloudFrontStep).toContain('https://$CLOUDFRONT_DOMAIN$login_path');
    expect(cloudFrontStep).toContain('x-amz-cf-id');
    expect(cloudFrontStep).toContain('Miss from cloudfront');
    expect(cloudFrontStep).toContain('id="loginForm"');
  });

  it('requires and records a specific restore point for a normal deployment', () => {
    const validation = stepBlock('Validate Deployment Inputs');

    expect(workflow).toContain('recoveryPointReference:');
    expect(workflow).toContain('recoveryPointTimestamp:');
    expect(workflow).toContain(
      'RECOVERY_POINT_REFERENCE: ${{ inputs.recoveryPointReference }}',
    );
    expect(workflow).toContain(
      'RECOVERY_POINT_TIMESTAMP: ${{ inputs.recoveryPointTimestamp }}',
    );
    expect(validation).toContain('RECOVERY_POINT_REFERENCE');
    expect(validation).toContain('recoveryPointTimestamp is in the future');
    expect(validation).toContain('GITHUB_STEP_SUMMARY');
  });
});

describe('repository hygiene contracts', () => {
  function lines(name: string): string[] {
    return readFileSync(resolve(projectRoot, name), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trim());
  }

  it('keeps key material and review artifacts out of the build context', () => {
    const dockerignore = lines('.dockerignore');

    for (const pattern of [
      '**/*.key',
      '**/*.pem',
      '**/*.crt',
      '**/*.csr',
      '**/*.srl',
      'artifacts/',
      '.cloud-attachments/',
    ]) {
      expect(dockerignore).toContain(pattern);
    }
    expect(dockerignore).toContain('.env*');
  });

  it('keeps review artifacts out of version control', () => {
    const gitignore = lines('.gitignore');

    expect(gitignore).toContain('/artifacts/');
    expect(gitignore).toContain('/.cloud-attachments/');
  });
});
