import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflow = readFileSync(
  resolve(projectRoot, '.github/workflows/deploy.yml'),
  'utf8',
).replace(/\r\n/g, '\n');

const imageUri =
  '111111111111.dkr.ecr.eu-central-1.amazonaws.com/unibudget:0f1e2d3c4b5a';
const buildImage =
  '111111111111.dkr.ecr.eu-central-1.amazonaws.com/unibudget:v1';

const temporaryDirectories: string[] = [];
const bashAvailable = spawnSync('bash', ['--version']).status === 0;
const windowsPathPattern = /^[A-Za-z]:[\\/]/;

/**
 * Bash cannot always open the Windows path Node hands it. Git Bash does, but
 * WSL needs `/mnt/c/...` and Cygwin needs `/cygdrive/c/...`. Ask bash whether
 * it can read the path, and only convert when it cannot, so a shell that
 * already understands the path is left untouched.
 */
function toBashPath(path: string): string {
  if (!bashAvailable || !windowsPathPattern.test(path)) {
    return path;
  }
  if (spawnSync('bash', ['-c', 'test -r "$1"', 'bash', path]).status === 0) {
    return path;
  }

  for (const converter of ['cygpath -u "$1"', 'wslpath -u "$1"']) {
    const converted = spawnSync('bash', ['-c', converter, 'bash', path], {
      encoding: 'utf8',
    });
    const candidate = converted.stdout?.trim() ?? '';
    if (converted.status !== 0 || candidate === '') {
      continue;
    }
    if (
      spawnSync('bash', ['-c', 'test -r "$1"', 'bash', candidate]).status === 0
    ) {
      return candidate;
    }
  }

  return path;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
  }
});

/**
 * Extracts the shell body of the migration step's `run: |` block, matching the
 * indentation the YAML block scalar uses.
 */
function migrationStepScript(): string {
  const lines = workflow.split('\n');
  const stepStart = lines.indexOf(
    '      - name: Run the One-Off Migration Task',
  );
  if (stepStart === -1) {
    throw new Error('The workflow has no one-off migration step.');
  }

  const runStart = lines.findIndex(
    (line, index) => index > stepStart && line === '        run: |',
  );
  if (runStart === -1) {
    throw new Error('The one-off migration step has no shell body.');
  }

  const body: string[] = [];
  for (let index = runStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }

  return body.join('\n');
}

interface StepRun {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  registration: () => Record<string, unknown> | undefined;
}

interface StepOptions {
  /**
   * Shrinks the 30-minute poll and the 120-second stop confirmation so the
   * timeout path can be exercised. Every replacement must match, otherwise the
   * test would silently wait for the production deadline.
   */
  compressDeadlines?: boolean;
}

function compressDeadlines(script: string): string {
  const replacements: Array<[string, string]> = [
    ['deadline=$((SECONDS + 1800))', 'deadline=$((SECONDS + 2))'],
    ['stop_deadline=$((SECONDS + 120))', 'stop_deadline=$((SECONDS + 2))'],
    ['sleep 10', 'sleep 1'],
    ['sleep 5', 'sleep 1'],
  ];
  let compressed = script;
  for (const [from, to] of replacements) {
    if (!compressed.includes(from)) {
      throw new Error(
        `The migration step no longer contains ${from}; update the deadline compression.`,
      );
    }
    compressed = compressed.replaceAll(from, to);
  }
  return compressed;
}

function runMigrationStep(
  overrides: Record<string, string> = {},
  options: StepOptions = {},
): StepRun {
  const directory = mkdtempSync(join(tmpdir(), 'unibudget-migration-step-'));
  temporaryDirectories.push(directory);

  const scriptPath = join(directory, 'migration.sh');
  writeFileSync(
    scriptPath,
    [
      // Git Bash's mktemp returns a POSIX path that the Windows Node binary
      // cannot open, so hand Bash a Windows path instead.
      'if command -v cygpath >/dev/null 2>&1; then',
      '  mktemp() { local p; p=$(command mktemp "$@") || return $?; cygpath -w "$p"; }',
      'fi',
      'aws() { node "$AWS_STUB" "$@"; }',
      options.compressDeadlines
        ? compressDeadlines(migrationStepScript())
        : migrationStepScript(),
      '',
    ].join('\n'),
  );

  const result = spawnSync('bash', [toBashPath(scriptPath)], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      AWS_STUB: resolve(projectRoot, 'tests/helpers/awsStub.mjs'),
      STUB_STATE_DIR: directory,
      IMAGE_URI: imageUri,
      MIGRATION_TASK_DEFINITION:
        'arn:aws:ecs:eu-central-1:111111111111:task-definition/UniBudgetStackMigrationTaskABC123',
      CLUSTER: 'unibudget-cluster',
      SECURITY_GROUP: 'sg-0123456789abcdef0',
      SUBNETS: 'subnet-0aaaaaaaaaaaaaaa,subnet-0bbbbbbbbbbbbbbb',
      ...overrides,
    },
  });

  const callsPath = join(directory, 'calls.log');
  const registeredPath = join(directory, 'registered.json');

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls: existsSync(callsPath)
      ? readFileSync(callsPath, 'utf8').trim().split('\n')
      : [],
    registration: () =>
      existsSync(registeredPath)
        ? JSON.parse(readFileSync(registeredPath, 'utf8'))
        : undefined,
  };
}

describe.skipIf(!bashAvailable)('one-off migration step execution', () => {
  it('registers a revision on the newly built image, runs it, and cleans up', () => {
    const run = runMigrationStep();

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Migration task completed successfully.');

    const registration = run.registration();
    expect(registration).toBeDefined();
    const containers = registration?.containerDefinitions as Array<{
      name: string;
      image: string;
      command: string[];
      environment: Array<{ name: string; value: string }>;
    }>;
    const migration = containers.find(
      (container) => container.name === 'MigrationContainer',
    );
    expect(migration?.image).toBe(imageUri);
    expect(migration?.command).toEqual(['node', './scripts/migrate.mjs']);
    expect(migration?.environment.map(({ name }) => name)).toEqual([
      'NODE_ENV',
      'PGHOST',
      'PGPORT',
      'PGDATABASE',
      'PGSSLMODE',
    ]);
    expect(registration?.taskRoleArn).toContain('MigrationTaskRole');
    expect(registration?.executionRoleArn).toContain(
      'MigrationTaskExecutionRole',
    );
    expect(registration?.runtimePlatform).toEqual({
      cpuArchitecture: 'X86_64',
      operatingSystemFamily: 'LINUX',
    });
    expect(registration).not.toHaveProperty('taskDefinitionArn');
    expect(registration).not.toHaveProperty('revision');
    expect(registration).not.toHaveProperty('status');

    expect(run.calls.filter((call) => call === 'run-task')).toHaveLength(1);
    expect(
      run.calls.filter((call) => call.startsWith('register-task-definition')),
    ).toHaveLength(1);
    expect(
      run.calls.filter((call) =>
        call.startsWith('deregister-task-definition'),
      ),
    ).toHaveLength(1);

    const registerIndex = run.calls.findIndex((call) =>
      call.startsWith('register-task-definition'),
    );
    const runIndex = run.calls.indexOf('run-task');
    const deregisterIndex = run.calls.findIndex((call) =>
      call.startsWith('deregister-task-definition'),
    );
    expect(registerIndex).toBeLessThan(runIndex);
    expect(runIndex).toBeLessThan(deregisterIndex);
  });

  it('fails the step and still cleans up when the migration container fails', () => {
    const run = runMigrationStep({ STUB_EXIT_CODES: '1' });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('exit codes [1]');
    expect(run.stdout).not.toContain('Migration task completed successfully.');
    expect(
      run.calls.filter((call) => call.startsWith('deregister-task-definition')),
    ).toHaveLength(1);
  });

  it('fails before running anything when the registered revision keeps the old image', () => {
    const run = runMigrationStep({ STUB_REGISTER_WRONG_IMAGE: '1' });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('not');
    expect(run.stdout).toContain('from this build');
    expect(run.calls).not.toContain('run-task');
  });

  it('fails clearly when the task cannot be placed', () => {
    const run = runMigrationStep({ STUB_RUN_FAILS: '1' });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      'ECS did not start the migration task: RESOURCE:MEMORY',
    );
    expect(
      run.calls.filter((call) => call === 'run-task'),
    ).toHaveLength(1);
    expect(
      run.calls.filter((call) => call.startsWith('deregister-task-definition')),
    ).toHaveLength(1);
  });

  it('keeps the revision registered when a stopped task never reaches STOPPED', () => {
    const run = runMigrationStep(
      { STUB_NEVER_STOPS: '1' },
      { compressDeadlines: true },
    );

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('did not finish within 30 minutes');
    expect(run.stdout).toContain('has not reached STOPPED');
    expect(run.stdout).toContain('Leaving');

    // The stop is requested twice (timeout path and cleanup), but the task
    // never confirms STOPPED, so the revision must stay registered.
    expect(run.calls.filter((call) => call === 'run-task')).toHaveLength(1);
    expect(
      run.calls.filter((call) => call === 'stop-task').length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      run.calls.filter((call) => call.startsWith('deregister-task-definition')),
    ).toHaveLength(0);
  }, 20_000);

  it('stops the task and keeps the revision when polling fails after launch', () => {
    // This is the cleanup path a cancellation takes: the task was started but
    // its stop was never confirmed. Git Bash on Windows does not deliver a
    // catchable SIGTERM to bash.exe, so the signal itself is not simulated
    // here; the failure after launch exercises the same cleanup branch.
    const run = runMigrationStep({ STUB_POLL_FAILS: '1' });

    expect(run.status).not.toBe(0);
    expect(run.calls.filter((call) => call === 'run-task')).toHaveLength(1);
    expect(run.calls.filter((call) => call === 'stop-task')).toHaveLength(1);
    expect(run.stdout).toContain('Migration task was interrupted');
    expect(run.stdout).toContain('Leaving');
    expect(
      run.calls.filter((call) => call.startsWith('deregister-task-definition')),
    ).toHaveLength(0);
  });

  it('fails when the temporary revision cannot be registered', () => {
    const run = runMigrationStep({ STUB_REGISTER_FAILS: '1' });

    expect(run.status).not.toBe(0);
    expect(run.calls).not.toContain('run-task');
    expect(run.registration()).toBeUndefined();
  });

  it('passes the newly built image and never uses container overrides', () => {
    const script = migrationStepScript();

    expect(script).toContain(
      'node scripts/migrationTaskDefinition.mjs \\\n  "$definition_file" "$IMAGE_URI"',
    );
    expect(script).not.toContain('containerOverrides');
    expect(script).not.toContain('--overrides');
    expect(script).not.toContain(buildImage);
  });
});
