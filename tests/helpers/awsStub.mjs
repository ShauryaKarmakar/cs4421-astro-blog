#!/usr/bin/env node
/**
 * Minimal `aws` stand-in used to exercise the deployment workflow's migration
 * step without contacting AWS. It emulates only the subcommands and queries
 * that step issues, and records every call in `<STUB_STATE_DIR>/calls.log`.
 *
 * Scenario switches:
 * - STUB_RUN_FAILS=1        run-task cannot place the task
 * - STUB_REGISTER_FAILS=1   register-task-definition fails
 * - STUB_REGISTER_WRONG_IMAGE=1  the registered revision keeps the old image
 * - STUB_EXIT_CODES=1       the migration container exits non-zero
 * - STUB_NEVER_STOPS=1      the task never reports STOPPED
 * - STUB_POLL_FAILS=1       polling the task fails after it started
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const stateDir = process.env.STUB_STATE_DIR;
const args = process.argv.slice(2);
const command = `${args[0] ?? ''} ${args[1] ?? ''}`;
const taskArn =
  'arn:aws:ecs:eu-central-1:111111111111:task/unibudget-cluster/0123456789abcdef';

function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : (args[index + 1] ?? '');
}

function record(entry) {
  appendFileSync(join(stateDir, 'calls.log'), `${entry}\n`);
}

const describedMigrationTask = {
  taskDefinitionArn:
    'arn:aws:ecs:eu-central-1:111111111111:task-definition/UniBudgetStackMigrationTaskABC123:1',
  family: 'UniBudgetStackMigrationTaskABC123',
  revision: 1,
  status: 'ACTIVE',
  taskRoleArn:
    'arn:aws:iam::111111111111:role/UniBudgetStack-MigrationTaskRole123-abcdef',
  executionRoleArn:
    'arn:aws:iam::111111111111:role/UniBudgetStack-MigrationTaskExecutionRole456-ghijkl',
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  cpu: '256',
  memory: '512',
  // Mirrors the synthesized task definition: no runtimePlatform is configured,
  // so Fargate defaults apply.
  runtimePlatform: {
    cpuArchitecture: 'X86_64',
    operatingSystemFamily: 'LINUX',
  },
  volumes: [],
  placementConstraints: [],
  compatibilities: ['EC2', 'FARGATE'],
  requiresAttributes: [{ name: 'com.amazonaws.ecs.capability.task-iam-role' }],
  registeredAt: '2026-10-24T10:00:00.000Z',
  registeredBy: 'arn:aws:iam::111111111111:role/UniBudgetStack-GitHubDeployRole',
  containerDefinitions: [
    {
      name: 'MigrationContainer',
      image: '111111111111.dkr.ecr.eu-central-1.amazonaws.com/unibudget:v1',
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
};

if (command === 'ecs describe-task-definition') {
  const query = flag('--query');
  record(`describe-task-definition ${query}`);

  if (query.includes('containerDefinitions')) {
    const registeredPath = join(stateDir, 'registered.json');
    if (!existsSync(registeredPath)) {
      process.stderr.write('An unknown revision was described.\n');
      process.exit(254);
    }
    const registered = JSON.parse(readFileSync(registeredPath, 'utf8'));
    const container = registered.containerDefinitions.find(
      (definition) => definition.name === 'MigrationContainer',
    );
    process.stdout.write(`${container?.image ?? 'None'}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({ taskDefinition: describedMigrationTask })}\n`,
    );
  }
  process.exit(0);
}

if (command === 'ecs register-task-definition') {
  if (process.env.STUB_REGISTER_FAILS === '1') {
    record('register-task-definition failed');
    process.stderr.write('An error occurred (AccessDeniedException)\n');
    process.exit(254);
  }

  const inputPath = flag('--cli-input-json').replace(/^file:\/\//, '');
  const registration = JSON.parse(readFileSync(inputPath, 'utf8'));
  if (process.env.STUB_REGISTER_WRONG_IMAGE === '1') {
    const container = registration.containerDefinitions.find(
      (definition) => definition.name === 'MigrationContainer',
    );
    container.image =
      '111111111111.dkr.ecr.eu-central-1.amazonaws.com/unibudget:v1';
  }
  writeFileSync(
    join(stateDir, 'registered.json'),
    JSON.stringify(registration, null, 2),
  );
  record('register-task-definition');
  process.stdout.write(
    'arn:aws:ecs:eu-central-1:111111111111:task-definition/UniBudgetStackMigrationTaskABC123:2\n',
  );
  process.exit(0);
}

if (command === 'ecs run-task') {
  record('run-task');
  if (process.env.STUB_RUN_FAILS === '1') {
    process.stdout.write('None\tRESOURCE:MEMORY\n');
  } else {
    process.stdout.write(`${taskArn}\tNone\n`);
  }
  process.exit(0);
}

if (command === 'ecs describe-tasks') {
  const query = flag('--query');
  record(`describe-tasks ${query}`);
  const isStatusQuery =
    !query.includes('containers[*].exitCode') &&
    !query.includes('stoppedReason');
  if (isStatusQuery && process.env.STUB_POLL_FAILS === '1') {
    process.stderr.write('An error occurred (ThrottlingException)\n');
    process.exit(254);
  }
  if (isStatusQuery && process.env.STUB_NEVER_STOPS === '1') {
    process.stdout.write('RUNNING\n');
    process.exit(0);
  }
  if (query.includes('containers[*].exitCode')) {
    process.stdout.write(`${process.env.STUB_EXIT_CODES ?? '0'}\n`);
  } else if (query.includes('stoppedReason')) {
    process.stdout.write('Essential container in task exited\n');
  } else {
    process.stdout.write('STOPPED\n');
  }
  process.exit(0);
}

if (command === 'ecs stop-task') {
  record('stop-task');
  process.exit(0);
}

if (command === 'ecs deregister-task-definition') {
  record(`deregister-task-definition ${flag('--task-definition')}`);
  process.exit(0);
}

record(`unexpected ${command}`);
process.stderr.write(`aws stub does not implement: ${command}\n`);
process.exit(254);
