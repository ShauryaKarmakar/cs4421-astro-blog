import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflow = readFileSync(
  resolve(projectRoot, '.github/workflows/backup-database.yml'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('scheduled database backup workflow', () => {
  it('runs on a daily schedule and on demand, never on a push', () => {
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain("cron: '15 2 * * *'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('push:');
    expect(workflow).not.toContain('pull_request:');
  });

  it('stays disabled until backups are explicitly enabled', () => {
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' || vars.BACKUP_ENABLED == 'true'",
    );
  });

  it('uses OIDC and no long-lived AWS credentials', () => {
    // The deploy role only trusts the production environment subject.
    expect(workflow).toContain('    environment: production\n');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('aws-actions/configure-aws-credentials@v4');
    expect(workflow).toContain(
      'role-to-assume: ${{ env.AWS_DEPLOY_ROLE_ARN }}',
    );
    expect(workflow).not.toContain('AWS_ACCESS_KEY_ID');
    expect(workflow).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('pins the verified bucket and project instead of repository variables', () => {
    expect(workflow).toContain(
      'BACKUP_BUCKET: unibudget-db-backups-556890483680-us-east-1',
    );
    expect(workflow).toContain('SUPABASE_PROJECT_REF: fkrtduyzpwfrbhooxvpr');
    expect(workflow).not.toContain('vars.BACKUP_BUCKET');
    expect(workflow).not.toContain('vars.SUPABASE_PROJECT_REF');
  });

  it('refuses an unencrypted or unversioned target', () => {
    expect(workflow).toContain('get-bucket-encryption');
    expect(workflow).toContain('is not encrypted');
    expect(workflow).toContain('get-bucket-versioning');
    expect(workflow).toContain('does not have versioning enabled');
  });

  it('fails closed when the credential secret is missing', () => {
    expect(workflow).toContain('secret is not configured');
    expect(workflow).toContain('exit 1');
  });

  it('keeps the connection string out of arguments and the log', () => {
    expect(workflow).toContain('export PGDATABASE="$BACKUP_DATABASE_URL"');
    expect(workflow).toContain('-e PGDATABASE');
    expect(workflow).not.toContain('echo "$BACKUP_DATABASE_URL"');
    expect(workflow).not.toContain('--dbname="$BACKUP_DATABASE_URL"');
  });

  it('writes a listable custom-format dump with a manifest', () => {
    expect(workflow).toContain('postgres:17');
    expect(workflow).toContain(
      'pg_dump --format=custom --no-owner --no-privileges',
    );
    expect(workflow).toContain('pg_restore --list');
    expect(workflow).toContain('sha256sum');
    expect(workflow).toContain('"sha256": "${checksum}"');
    expect(workflow).toContain('"bytes": ${bytes}');
    expect(workflow).toContain(
      '"operator": "github-actions:${GITHUB_RUN_ID}"',
    );
  });

  it('uploads under the project prefix and verifies the stored object', () => {
    expect(workflow).toContain(
      'prefix="supabase/${SUPABASE_PROJECT_REF}/${timestamp}"',
    );
    expect(workflow).toContain('s3://$BACKUP_BUCKET/$prefix/$dump_name');
    expect(workflow).toContain('remote_checksum');
    expect(workflow).toContain('does not match its SHA-256');
    expect(workflow).not.toContain('--delete');
  });

  it('never touches application or monitoring resources', () => {
    for (const forbidden of [
      'cdk deploy',
      'ecs update-service',
      'run-task',
      'cloudfront',
      'sns publish',
    ]) {
      expect(workflow).not.toContain(forbidden);
    }
  });
});
