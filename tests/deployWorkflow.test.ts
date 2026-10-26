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

  it('validates the exact secret ARN and JSON key for every migration secret', () => {
    const validation = stepBlock('Validate Migration Task Configuration');

    expect(validation).toContain('require_exact_secret() {');
    expect(validation).toContain(
      'local name=$1 arn=$2 suffix=$3 count actual expected',
    );
    expect(validation).toContain('expected="$arn$suffix"');
    expect(validation).toContain('if [ "$actual" != "$expected" ]; then');
    expect(validation).toContain(
      'does not reference the expected Secrets Manager ARN and JSON key',
    );

    // Each variable must name its own key against its own secret.
    expect(validation).toContain(
      `require_exact_secret PGUSER "$SUPABASE_MIGRATION_SECRET_ARN" ':username::'`,
    );
    expect(validation).toContain(
      `require_exact_secret PGPASSWORD "$SUPABASE_MIGRATION_SECRET_ARN" ':password::'`,
    );
    expect(validation).toContain(
      `require_exact_secret APP_DATABASE_PASSWORD "$SUPABASE_APPLICATION_SECRET_ARN" ':password::'`,
    );
    expect(validation).toContain(
      `require_exact_secret SUPABASE_CA_CERT "$SUPABASE_CA_SECRET_ARN" ''`,
    );

    // A swapped key must not pass: PGUSER may not point at the password key,
    // and PGPASSWORD may not point at the username key.
    expect(validation).not.toContain(
      `require_exact_secret PGUSER "$SUPABASE_MIGRATION_SECRET_ARN" ':password::'`,
    );
    expect(validation).not.toContain(
      `require_exact_secret PGPASSWORD "$SUPABASE_MIGRATION_SECRET_ARN" ':username::'`,
    );
    expect(validation).not.toContain(
      `require_exact_secret APP_DATABASE_PASSWORD "$SUPABASE_APPLICATION_SECRET_ARN" ':username::'`,
    );

    // No wildcard or prefix form may remain in the comparison.
    expect(validation).not.toContain('"$expected":*::');
    expect(validation).not.toContain('"$expected"|"$expected"');
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
    expect(cloudFrontStep).not.toContain('bootstrapOnly');
    expect(cloudFrontStep).toContain(
      'DISTRIBUTION_ID: ${{ steps.outputs.outputs.cloudfront_distribution_id }}',
    );
    expect(cloudFrontStep).toContain(
      'LOAD_BALANCER_DNS: ${{ steps.outputs.outputs.load_balancer_dns }}',
    );
    expect(cloudFrontStep).toContain('cloudfront get-distribution-config');
    expect(cloudFrontStep).toContain(
      `require_config "origin count" "$(jq -r '.Origins.Items | length' <<<"$config")" "1"`,
    );
    expect(cloudFrontStep).toContain('.Origins.Items[0].DomainName');
    expect(cloudFrontStep).not.toContain("jq -r '.Origins | length'");
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

  it('rejects edge configuration that could synthesize a response', () => {
    const cloudFrontStep = stepBlock('Verify CloudFront Delivery Configuration');

    const driftChecks = [
      ['cache behavior count', '(.CacheBehaviors.Items // []) | length'],
      ['custom error response count', '(.CustomErrorResponses.Items // []) | length'],
      [
        'CloudFront function association count',
        '(.DefaultCacheBehavior.FunctionAssociations.Items // []) | length',
      ],
      [
        'Lambda@Edge association count',
        '(.DefaultCacheBehavior.LambdaFunctionAssociations.Items // []) | length',
      ],
    ];

    for (const [label, expression] of driftChecks) {
      // The expected count is 0, so an unexpected cache behavior, custom
      // error response, or edge function association fails closed.
      expect(cloudFrontStep).toContain(
        `require_config "${label}" "$(jq -r '${expression}' <<<"$config")" "0"`,
      );
    }
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
    expect(health).toContain('/login');
    // Health and login are not enough: render a real content route too.
    expect(health).toContain('src/content/blog');
    expect(health).toContain('/blog/${sample_slug}');
    expect(health).toContain('blog_code');
    expect(health).toContain('missing_slug');
    expect(health).toContain('missing_code');
    expect(health).toContain('expected 404');
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
      'Confirm the Stack Exists',
      'Read Stack Outputs',
      'Verify the Deployment Alarm Before Rolling Out',
      'Verify ECR Retention Policy Before Image Push',
      'Verify CloudFront Delivery Configuration',
      'Build and Push Application Image',
      'Validate Migration Task Configuration',
      'Run the One-Off Migration Task',
      'Deploy the Stack with the Migrated Image',
      'Wait for the ECS Service',
      'Verify the Running Image',
      'Verify Application Health Through CloudFront',
      'Verify Request Correlation Through CloudFront',
    ];
    const positions = names.map((name) =>
      workflow.indexOf(`      - name: ${name}\n`),
    );

    expect(positions.every((index) => index > -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('fails the release when the login response loses request correlation', () => {
    const gate = stepBlock('Verify Request Correlation Through CloudFront');
    const health = stepBlock('Verify Application Health Through CloudFront');
    const healthIndex = workflow.indexOf(
      '      - name: Verify Application Health Through CloudFront\n',
    );
    const gateIndex = workflow.indexOf(
      '      - name: Verify Request Correlation Through CloudFront\n',
    );

    expect(healthIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeGreaterThan(healthIndex);
    expect(gate).not.toContain('bootstrapOnly');
    expect(gate).toContain(
      'APPLICATION_URL: ${{ steps.outputs.outputs.application_url }}',
    );
    expect(gate).toContain('${APPLICATION_URL%/}/login');
    expect(gate).toContain('--dump-header -');
    expect(gate).toContain('awk \'tolower($1) == "x-request-id:" {print $2}\'');
    expect(gate).toContain('if [ -z "$request_id" ]');
    expect(gate).toContain(
      'The application did not return an X-Request-Id header through CloudFront.',
    );
    expect(gate).toContain('^[A-Za-z0-9._-]{8,64}$');
    expect(gate).toContain('is malformed');

    // The correlation check is additive. The status checks it sits beside stay
    // in force, so a 200 is still required independently of the header.
    expect(health).toContain('--fail');
    expect(health).toContain('login_code');
  });

  it('keeps the correlation gate free of response data and soft failures', () => {
    const gate = stepBlock('Verify Request Correlation Through CloudFront');

    expect(gate).not.toContain('echo "$request_id"');
    expect(gate).not.toContain('set-cookie');
    expect(gate).not.toContain('authorization');
    expect(gate).not.toMatch(/\|\|\s*true/);
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

  it('migrates with a temporary revision built from the newly built image', () => {
    const step = stepBlock('Run the One-Off Migration Task');

    expect(step).toContain('IMAGE_URI: ${{ steps.image.outputs.image_uri }}');
    expect(step).toContain(
      'MIGRATION_TASK_DEFINITION: ${{ steps.outputs.outputs.migration_task_definition }}',
    );
    expect(step).toContain('node scripts/migrationTaskDefinition.mjs');
    expect(step).toContain('"$definition_file" "$IMAGE_URI"');
    expect(step).toContain('--cli-input-json "file://$registration_file"');
    expect(step).toContain(
      "taskDefinition.containerDefinitions[?name=='MigrationContainer'].image",
    );
    expect(step).toContain('if [ "$registered_image" != "$IMAGE_URI" ]; then');

    // register-task-definition rejects an image override, and the service must
    // never be scaled down to migrate.
    expect(step).not.toContain('containerOverrides');
    expect(step).not.toContain('--overrides');
    expect(step).not.toContain('update-service');
    expect(workflow).not.toContain('containerOverrides.image');
  });

  it('records the release version and commit in the image provenance', () => {
    const build = stepBlock('Build and Push Application Image');
    const dockerfile = readFileSync(resolve(projectRoot, 'dockerfile'), 'utf8');

    expect(build).toContain('--build-arg IMAGE_VERSION="$IMAGE_TAG"');
    expect(build).toContain(
      '--build-arg GIT_REVISION="${GITHUB_SHA:-unknown}"',
    );
    expect(dockerfile).toContain('org.opencontainers.image.version');
    expect(dockerfile).toContain('org.opencontainers.image.revision');
  });

  it('requires a semantic release tag', () => {
    const validation = stepBlock('Validate Deployment Inputs');

    expect(validation).toContain('node scripts/releaseTag.mjs "$IMAGE_TAG"');
    expect(validation).toContain('semantic release version');
  });

  it('requires the annotated release tag to point at the deployed commit', () => {
    const validation = stepBlock('Validate Deployment Inputs');

    expect(workflow).toContain('fetch-depth: 0');
    expect(validation).toContain(
      'git rev-parse -q --verify "refs/tags/$IMAGE_TAG^{commit}"',
    );
    expect(validation).toContain('git cat-file -t "refs/tags/$IMAGE_TAG"');
    expect(validation).toContain('must be an annotated tag');
    expect(validation).toContain('git rev-list -n 1 "refs/tags/$IMAGE_TAG"');
    expect(validation).toContain('"$tag_commit" != "$GITHUB_SHA"');
  });

  it('blocks an unsafe ECR retention policy before building or pushing', () => {
    const policyStep = stepBlock('Verify ECR Retention Policy Before Image Push');
    const buildIndex = workflow.indexOf(
      '      - name: Build and Push Application Image\n',
    );
    const policyIndex = workflow.indexOf(
      '      - name: Verify ECR Retention Policy Before Image Push\n',
    );

    expect(policyStep).toContain('aws ecr get-lifecycle-policy');
    expect(policyStep).toContain('node scripts/ecrLifecyclePolicy.mjs -');
    expect(policyStep).toContain('printf \'%s\' "$policy_text"');
    expect(policyIndex).toBeGreaterThan(-1);
    expect(policyIndex).toBeLessThan(buildIndex);
  });

  it('leaves monitoring ownership out of the application deployment workflow', () => {
    expect(workflow).not.toContain('ALARM_TOPIC_ARN');
    expect(workflow).not.toContain('-c alarmTopicArn');
    // The workflow references the alarm by name but never creates it: the
    // monitoring stack stays a separate, separately approved deployment.
    expect(workflow).not.toContain('cdk deploy UniBudgetStack-Monitoring');
    expect(workflow).not.toContain('-c monitoringOnly');
  });

  it('updates an existing stack and never bootstraps a new one', () => {
    expect(workflow).not.toContain('bootstrapOnly');
    expect(workflow).not.toContain('Create the Initial Stack');

    const exists = stepBlock('Confirm the Stack Exists');
    expect(exists).toContain('aws cloudformation describe-stacks');
    expect(exists).toContain('Create the stack first');
    expect(exists).toContain('exit 1');
  });

  it('rolls out only with a verified deployment alarm', () => {
    const validation = stepBlock('Validate Deployment Inputs');
    const preflight = stepBlock('Verify the Deployment Alarm Before Rolling Out');
    const deploy = stepBlock('Deploy the Stack with the Migrated Image');

    expect(workflow).toContain(
      "DEPLOYMENT_ALARM_NAME: ${{ vars.DEPLOYMENT_ALARM_NAME || 'UniBudgetStack-Monitoring-Request5xx' }}",
    );
    expect(validation).toContain('DEPLOYMENT_ALARM_NAME');
    expect(validation).toContain(
      'automatic rollback cannot be configured without one',
    );

    // The pre-flight proves the alarm exists and measures request failures,
    // so a same-named alarm over another metric cannot pass.
    expect(preflight).not.toContain('bootstrapOnly');
    expect(preflight).toContain('aws cloudwatch describe-alarms');
    expect(preflight).toContain('UniBudget/Application');
    expect(preflight).toContain('Http5xxCount');
    expect(preflight).toContain('ActionsEnabled');
    expect(preflight).toContain(
      'Deploy UniBudgetStack-Monitoring before rolling out the application',
    );
    expect(preflight).toContain('exit 1');

    expect(deploy).toContain('-c deploymentAlarmName="$DEPLOYMENT_ALARM_NAME"');
  });

  it('verifies the deployment alarm before building the image or migrating', () => {
    const preflightIndex = workflow.indexOf(
      '      - name: Verify the Deployment Alarm Before Rolling Out\n',
    );
    const buildIndex = workflow.indexOf(
      '      - name: Build and Push Application Image\n',
    );
    const migrationIndex = workflow.indexOf(
      '      - name: Run the One-Off Migration Task\n',
    );

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(buildIndex);
    expect(preflightIndex).toBeLessThan(migrationIndex);
  });

  it('fails the release when the service lost its deployment alarm', () => {
    const running = stepBlock('Verify the Running Image');

    expect(running).toContain(
      'DEPLOYMENT_ALARM_NAME: ${{ env.DEPLOYMENT_ALARM_NAME }}',
    );
    expect(running).toContain('.deploymentConfiguration.alarms.enable == true');
    expect(running).toContain(
      '.deploymentConfiguration.alarms.rollback == true',
    );
    expect(running).toContain('index($alarm)');
    expect(running).toContain('automatic rollback is not configured');
  });

  it('records the published digest and verifies the running task uses it', () => {
    const build = stepBlock('Build and Push Application Image');
    const running = stepBlock('Verify the Running Image');

    expect(build).toContain('image_digest=$(aws ecr describe-images');
    expect(build).toContain('echo "image_digest=$image_digest" >> "$GITHUB_OUTPUT"');
    expect(build).toContain('sha256:[0-9a-f]{64}');
    expect(running).toContain(
      'IMAGE_DIGEST: ${{ steps.image.outputs.image_digest }}',
    );
    expect(running).toContain('aws ecs list-tasks');
    expect(running).toContain('aws ecs describe-tasks');
    expect(running).toContain('.imageDigest == $digest');
    // A circuit-breaker rollback can leave the previous task set healthy, so
    // the release must also refuse a primary deployment that did not complete.
    expect(running).toContain('rollout_state');
    expect(running).toContain(
      '.deployments[] | select(.status == "PRIMARY")',
    );
    expect(running).toContain('!= "COMPLETED"');
  });

  it('runs the application test suite before building the image', () => {
    const testsIndex = workflow.indexOf('      - name: Run Tests\n');
    const buildIndex = workflow.indexOf(
      '      - name: Build and Push Application Image\n',
    );

    expect(testsIndex).toBeGreaterThan(-1);
    expect(testsIndex).toBeLessThan(buildIndex);
    expect(stepBlock('Run Tests')).toContain('npm test -- --run');
  });

  it('provides the PostgreSQL service the deployment test suite requires', () => {
    // The integration suites fail closed without these; without the service the
    // release stops at the test gate instead of silently skipping coverage.
    expect(workflow).toContain('image: postgres:16');
    expect(workflow).toContain('BUDGET_TEST_DATABASE_URL: postgresql://');
    expect(workflow).toContain('MIGRATION_TEST_DATABASE_URL: postgresql://');
  });

  it('gates the rollout on the migration and reuses the same image tag', () => {
    const build = stepBlock('Build and Push Application Image');
    expect(build).toContain('image_uri="$REPOSITORY_URI:$IMAGE_TAG"');
    expect(build).toContain('echo "image_uri=$image_uri" >> "$GITHUB_OUTPUT"');

    const migrationIndex = workflow.indexOf(
      '      - name: Run the One-Off Migration Task\n',
    );
    const deployIndex = workflow.indexOf(
      '      - name: Deploy the Stack with the Migrated Image\n',
    );
    expect(migrationIndex).toBeGreaterThan(-1);
    expect(migrationIndex).toBeLessThan(deployIndex);

    expect(stepBlock('Deploy the Stack with the Migrated Image')).toContain(
      '-c imageTag="$IMAGE_TAG"',
    );
    expect(stepBlock('Verify the Running Image')).toContain(
      'IMAGE_URI: ${{ steps.image.outputs.image_uri }}',
    );
  });

  it('deregisters the temporary revision only after the migration task stops', () => {
    const step = stepBlock('Run the One-Off Migration Task');
    const cleanupStart = step.indexOf('cleanup() {');
    const cleanup = step.slice(cleanupStart, step.indexOf('trap cleanup EXIT'));

    expect(cleanupStart).toBeGreaterThan(-1);
    expect(cleanup).toContain('aws ecs stop-task');
    expect(cleanup).toContain('aws ecs deregister-task-definition');
    expect(cleanup).toContain('[ "$task_finished" = "true" ]');
    expect(cleanup.indexOf('stop-task')).toBeLessThan(
      cleanup.indexOf('deregister-task-definition'),
    );
  });

  it('confirms STOPPED before the timeout path can deregister the revision', () => {
    const step = stepBlock('Run the One-Off Migration Task');
    const timeoutStart = step.indexOf('did not finish within 30 minutes');
    const timeoutBlock = step.slice(timeoutStart, step.indexOf('stopped_reason='));

    expect(timeoutStart).toBeGreaterThan(-1);
    expect(timeoutBlock).toContain('stop_deadline=$((SECONDS + 120))');
    expect(timeoutBlock).toContain('if [ "$last_status" = "STOPPED" ]');
    expect(timeoutBlock).toContain('task_finished="true"');
    expect(timeoutBlock).toContain(
      'leaving the temporary task definition registered',
    );
    expect(
      timeoutBlock.indexOf('if [ "$last_status" = "STOPPED" ]'),
    ).toBeLessThan(timeoutBlock.indexOf('task_finished="true"'));
  });
});
