import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MIGRATION_CONTAINER_NAME,
  MigrationTaskDefinitionError,
  buildMigrationTaskDefinition,
} from '../scripts/migrationTaskDefinition.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const builderPath = resolve(projectRoot, 'scripts/migrationTaskDefinition.mjs');
const imageUri =
  '111111111111.dkr.ecr.eu-central-1.amazonaws.com/unibudget:a1b2c3d4e5f6';

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'unibudget-migration-task-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
  }
});

/**
 * Mirrors the shape returned by `aws ecs describe-task-definition`, including
 * the read-only fields that `register-task-definition` rejects.
 */
function describedMigrationTask() {
  return {
    taskDefinitionArn:
      'arn:aws:ecs:eu-central-1:111111111111:task-definition/UniBudgetStackMigrationTaskABC123:1',
    containerDefinitions: [
      {
        name: MIGRATION_CONTAINER_NAME,
        image:
          '111111111111.dkr.ecr.eu-central-1.amazonaws.com/unibudget:v1',
        essential: true,
        command: ['node', './scripts/migrate.mjs'],
        environment: [
          { name: 'NODE_ENV', value: 'production' },
          { name: 'PGHOST', value: 'db.example.supabase.com' },
          { name: 'PGPORT', value: '5432' },
          { name: 'PGDATABASE', value: 'postgres' },
          { name: 'PGSSLMODE', value: 'verify-full' },
        ],
        secrets: [
          {
            name: 'PGUSER',
            valueFrom:
              'arn:aws:secretsmanager:eu-central-1:111111111111:secret:unibudget/supabase/migration-AbCdEf:username::',
          },
          {
            name: 'SUPABASE_CA_CERT',
            valueFrom:
              'arn:aws:secretsmanager:eu-central-1:111111111111:secret:unibudget/supabase/ca-GhIjKl:',
          },
        ],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': '/unibudget/migration',
            'awslogs-region': 'eu-central-1',
            'awslogs-stream-prefix': 'migration',
          },
        },
        stopTimeout: 30,
      },
    ],
    family: 'UniBudgetStackMigrationTaskABC123',
    taskRoleArn:
      'arn:aws:iam::111111111111:role/UniBudgetStack-MigrationTaskRole123-abcdef',
    executionRoleArn:
      'arn:aws:iam::111111111111:role/UniBudgetStack-MigrationTaskExecutionRole456-ghijkl',
    networkMode: 'awsvpc',
    revision: 1,
    status: 'ACTIVE',
    requiresAttributes: [
      { name: 'com.amazonaws.ecs.capability.task-iam-role' },
      { name: 'ecs.capability.execution-role-ecr-pull' },
    ],
    placementConstraints: [],
    compatibilities: ['EC2', 'FARGATE'],
    requiresCompatibilities: ['FARGATE'],
    cpu: '256',
    memory: '512',
    // The stack does not set runtimePlatform, so this is what Fargate reports
    // for the synthesized definition.
    runtimePlatform: {
      cpuArchitecture: 'X86_64',
      operatingSystemFamily: 'LINUX',
    },
    volumes: [],
    registeredAt: '2026-10-24T10:00:00.000Z',
    registeredBy: 'arn:aws:iam::111111111111:role/UniBudgetStack-GitHubDeployRole',
    deleteRequestedAt: '2026-10-24T11:00:00.000Z',
  };
}

function runBuilder(description: unknown, image = imageUri) {
  const directory = makeTemporaryDirectory();
  const descriptionPath = join(directory, 'described-task.json');
  writeFileSync(descriptionPath, JSON.stringify(description), 'utf8');

  return spawnSync(process.execPath, [builderPath, descriptionPath, image], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

describe('buildMigrationTaskDefinition', () => {
  it('replaces only the migration container image', () => {
    const described = describedMigrationTask();
    const registration = buildMigrationTaskDefinition(described, imageUri);

    expect(registration.containerDefinitions).toHaveLength(1);
    expect(registration.containerDefinitions[0].image).toBe(imageUri);
    expect(registration.containerDefinitions[0].name).toBe(
      MIGRATION_CONTAINER_NAME,
    );
  });

  it('preserves roles, sizing, compatibilities, runtime platform, and command', () => {
    const described = describedMigrationTask();
    const registration = buildMigrationTaskDefinition(described, imageUri);

    for (const field of [
      'family',
      'taskRoleArn',
      'executionRoleArn',
      'networkMode',
      'cpu',
      'memory',
      'requiresCompatibilities',
      'runtimePlatform',
      'placementConstraints',
      'volumes',
    ]) {
      expect(registration[field], field).toEqual(described[field]);
    }

    const container = registration.containerDefinitions[0];
    expect(container.command).toEqual(['node', './scripts/migrate.mjs']);
    expect(container.essential).toBe(true);
  });

  it('preserves environment, secrets, and logging so the migration can run', () => {
    const described = describedMigrationTask();
    const registration = buildMigrationTaskDefinition(described, imageUri);
    const container = registration.containerDefinitions[0];

    expect(container.environment).toEqual(
      described.containerDefinitions[0].environment,
    );
    expect(container.secrets).toEqual(
      described.containerDefinitions[0].secrets,
    );
    expect(container.logConfiguration).toEqual(
      described.containerDefinitions[0].logConfiguration,
    );
    expect(container.stopTimeout).toBe(30);
  });

  it('drops read-only fields that register-task-definition rejects', () => {
    const registration = buildMigrationTaskDefinition(
      describedMigrationTask(),
      imageUri,
    );

    for (const field of [
      'taskDefinitionArn',
      'revision',
      'status',
      'requiresAttributes',
      'compatibilities',
      'registeredAt',
      'registeredBy',
      'deregisteredAt',
      'deleteRequestedAt',
    ]) {
      expect(registration, field).not.toHaveProperty(field);
    }
  });

  it('accepts the describe-task-definition response wrapper', () => {
    const registration = buildMigrationTaskDefinition(
      { taskDefinition: describedMigrationTask() },
      imageUri,
    );

    expect(registration.family).toBe(describedMigrationTask().family);
    expect(registration.containerDefinitions[0].image).toBe(imageUri);
  });

  it('does not mutate the described task definition', () => {
    const described = describedMigrationTask();
    const snapshot = structuredClone(described);

    buildMigrationTaskDefinition(described, imageUri);

    expect(described).toEqual(snapshot);
  });

  it('keeps other containers untouched if the definition ever gains one', () => {
    const described = describedMigrationTask();
    described.containerDefinitions.unshift({
      name: 'SidecarContainer',
      image: 'public.ecr.aws/docker/library/busybox:1.36',
      essential: false,
      command: ['sleep', '5'],
    });

    const registration = buildMigrationTaskDefinition(described, imageUri);
    const sidecar = registration.containerDefinitions.find(
      (container: { name: string }) => container.name === 'SidecarContainer',
    );

    expect(sidecar?.image).toBe('public.ecr.aws/docker/library/busybox:1.36');
    expect(
      registration.containerDefinitions.find(
        (container: { name: string }) =>
          container.name === MIGRATION_CONTAINER_NAME,
      )?.image,
    ).toBe(imageUri);
  });

  it('refuses a definition without a migration container', () => {
    const described = describedMigrationTask();
    described.containerDefinitions[0].name = 'ApplicationContainer';

    expect(() => buildMigrationTaskDefinition(described, imageUri)).toThrow(
      MigrationTaskDefinitionError,
    );
    expect(() => buildMigrationTaskDefinition(described, imageUri)).toThrow(
      /no MigrationContainer container/,
    );
  });

  it('refuses a definition with duplicate migration containers', () => {
    const described = describedMigrationTask();
    described.containerDefinitions.push(
      structuredClone(described.containerDefinitions[0]),
    );

    expect(() => buildMigrationTaskDefinition(described, imageUri)).toThrow(
      /2 MigrationContainer containers/,
    );
  });

  it('refuses an empty, whitespace, or untagged image reference', () => {
    const described = describedMigrationTask();

    expect(() => buildMigrationTaskDefinition(described, '')).toThrow(
      /non-empty string/,
    );
    expect(() =>
      buildMigrationTaskDefinition(described, 'unibudget:a b'),
    ).toThrow(/must not contain whitespace/);
    expect(() =>
      buildMigrationTaskDefinition(
        described,
        '111111111111.dkr.ecr.eu-central-1.amazonaws.com/unibudget',
      ),
    ).toThrow(/explicit tag or digest/);
  });

  it('refuses a described field it cannot preserve instead of dropping it', () => {
    const described = describedMigrationTask();
    (described as Record<string, unknown>).futureExecutionOption = {
      mode: 'strict',
    };

    expect(() => buildMigrationTaskDefinition(described, imageUri)).toThrow(
      MigrationTaskDefinitionError,
    );
    expect(() => buildMigrationTaskDefinition(described, imageUri)).toThrow(
      /cannot preserve: futureExecutionOption/,
    );
  });

  it('refuses a definition without a family', () => {
    const described = describedMigrationTask();
    delete (described as { family?: string }).family;

    expect(() => buildMigrationTaskDefinition(described, imageUri)).toThrow(
      /no family name/,
    );
  });

  it('accepts a digest-pinned image reference', () => {
    const digest =
      '111111111111.dkr.ecr.eu-central-1.amazonaws.com/unibudget@sha256:0123456789abcdef';

    const registration = buildMigrationTaskDefinition(
      describedMigrationTask(),
      digest,
    );

    expect(registration.containerDefinitions[0].image).toBe(digest);
  });
});

describe('migrationTaskDefinition CLI', () => {
  it('writes the registration payload to stdout', () => {
    const result = runBuilder(describedMigrationTask());

    expect(result.status).toBe(0);
    const registration = JSON.parse(result.stdout);
    expect(registration.family).toBe(describedMigrationTask().family);
    expect(registration.containerDefinitions[0].image).toBe(imageUri);
    expect(registration).not.toHaveProperty('taskDefinitionArn');
  });

  it('exits non-zero with a diagnostic when the definition is unusable', () => {
    const result = runBuilder({ family: 'Unusable', containerDefinitions: [] });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no container definitions');
  });

  it('exits non-zero when the image reference is missing', () => {
    const result = spawnSync(
      process.execPath,
      [builderPath, join(projectRoot, 'package.json')],
      { cwd: projectRoot, encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Usage: migrationTaskDefinition.mjs');
  });
});
