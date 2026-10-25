#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * ECS container overrides have no `image` field: `containerOverrides` accepts
 * only name, environment, command, and resource limits, so an "image override"
 * is rejected by ParamValidation. To migrate an existing stack with the image
 * this workflow run built, the workflow re-registers the stack's migration task
 * definition with only the migration container's image replaced.
 *
 * This module builds that registration payload. It copies the fields
 * `register-task-definition` accepts from the definition returned by
 * `describe-task-definition` and drops the read-only fields that the register
 * API rejects (ARNs, revision numbers, status, computed attributes).
 */

/**
 * Fields accepted by `register-task-definition`. Everything else returned by
 * `describe-task-definition` is read-only and must not be sent back.
 */
export const REGISTRABLE_FIELDS = Object.freeze([
  'family',
  'taskRoleArn',
  'executionRoleArn',
  'networkMode',
  'containerDefinitions',
  'volumes',
  'placementConstraints',
  'requiresCompatibilities',
  'cpu',
  'memory',
  'tags',
  'pidMode',
  'ipcMode',
  'proxyConfiguration',
  'inferenceAccelerators',
  'ephemeralStorage',
  'runtimePlatform',
  'enableFaultInjection',
]);

/**
 * Fields the register API rejects because ECS computes them.
 */
export const READ_ONLY_FIELDS = Object.freeze([
  'taskDefinitionArn',
  'revision',
  'status',
  'requiresAttributes',
  'compatibilities',
  'registeredAt',
  'registeredBy',
  'deregisteredAt',
  'deleteRequestedAt',
]);

/**
 * Every field `describe-task-definition` is known to return. A field outside
 * this set is rejected instead of being dropped: silently discarding a new
 * ECS option could change how the one-off task runs.
 */
const KNOWN_FIELDS = new Set([...REGISTRABLE_FIELDS, ...READ_ONLY_FIELDS]);

export const MIGRATION_CONTAINER_NAME = 'MigrationContainer';

export class MigrationTaskDefinitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationTaskDefinitionError';
  }
}

function assertImageUri(imageUri) {
  if (typeof imageUri !== 'string' || imageUri.trim() === '') {
    throw new MigrationTaskDefinitionError('The migration image URI must be a non-empty string.');
  }
  if (/\s/.test(imageUri)) {
    throw new MigrationTaskDefinitionError(
      `The migration image URI must not contain whitespace: ${JSON.stringify(imageUri)}`,
    );
  }
  // A bare repository name would silently resolve to :latest and undo the
  // immutable-image guarantee this step exists to enforce.
  const lastSegment = imageUri.split('/').pop() ?? '';
  if (!lastSegment.includes(':') && !imageUri.includes('@sha256:')) {
    throw new MigrationTaskDefinitionError(
      `The migration image URI must carry an explicit tag or digest: ${imageUri}`,
    );
  }
}

function findMigrationContainer(containerDefinitions) {
  if (!Array.isArray(containerDefinitions) || containerDefinitions.length === 0) {
    throw new MigrationTaskDefinitionError(
      'The described task definition has no container definitions.',
    );
  }
  const matches = containerDefinitions.filter(
    (container) => container && container.name === MIGRATION_CONTAINER_NAME,
  );
  if (matches.length === 0) {
    throw new MigrationTaskDefinitionError(
      `The described task definition has no ${MIGRATION_CONTAINER_NAME} container.`,
    );
  }
  if (matches.length > 1) {
    throw new MigrationTaskDefinitionError(
      `The described task definition has ${matches.length} ${MIGRATION_CONTAINER_NAME} containers.`,
    );
  }
  return matches[0];
}

/**
 * Build the `register-task-definition` payload for a one-off migration task.
 *
 * @param {object} description `taskDefinition` from `describe-task-definition`
 *   (the `{ taskDefinition: ... }` wrapper is also accepted).
 * @param {string} imageUri Immutable image identifier built by this run.
 * @returns {object} Payload for `aws ecs register-task-definition --cli-input-json`
 */
export function buildMigrationTaskDefinition(description, imageUri) {
  const described =
    description && typeof description === 'object' && description.taskDefinition
      ? description.taskDefinition
      : description;

  if (!described || typeof described !== 'object') {
    throw new MigrationTaskDefinitionError(
      'The described task definition must be an object.',
    );
  }
  if (typeof described.family !== 'string' || described.family.trim() === '') {
    throw new MigrationTaskDefinitionError(
      'The described task definition has no family name.',
    );
  }

  assertImageUri(imageUri);
  findMigrationContainer(described.containerDefinitions);

  const unsupported = Object.keys(described).filter(
    (field) => !KNOWN_FIELDS.has(field),
  );
  if (unsupported.length > 0) {
    unsupported.sort();
    throw new MigrationTaskDefinitionError(
      `The described task definition has fields this builder cannot preserve: ${unsupported.join(', ')}. ` +
        'Add each one to REGISTRABLE_FIELDS (if register-task-definition accepts it) or to READ_ONLY_FIELDS (if ECS computes it) instead of dropping it silently.',
    );
  }

  const registration = {};
  for (const field of REGISTRABLE_FIELDS) {
    if (described[field] === undefined || described[field] === null) continue;
    registration[field] =
      typeof described[field] === 'object'
        ? structuredClone(described[field])
        : described[field];
  }

  for (const field of READ_ONLY_FIELDS) {
    if (field in registration) {
      throw new MigrationTaskDefinitionError(
        `Refusing to send the read-only field ${field} to register-task-definition.`,
      );
    }
  }

  registration.containerDefinitions = registration.containerDefinitions.map((container) => {
    if (container.name !== MIGRATION_CONTAINER_NAME) return container;
    return { ...container, image: imageUri };
  });

  // The register API requires a family; reassert it after filtering so a
  // malformed description cannot quietly fall back to a different family.
  registration.family = described.family;

  return registration;
}

function readDescription(path) {
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new MigrationTaskDefinitionError(
      `Could not parse ${path} as JSON: ${error.message}`,
    );
  }
}

function main(argv) {
  const [descriptionPath, imageUri] = argv;
  if (!descriptionPath || !imageUri) {
    process.stderr.write(
      'Usage: migrationTaskDefinition.mjs <described-task-definition.json> <image-uri>\n',
    );
    return 2;
  }

  try {
    const registration = buildMigrationTaskDefinition(
      readDescription(descriptionPath),
      imageUri,
    );
    process.stdout.write(`${JSON.stringify(registration, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`migration task definition: ${error.message}\n`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
