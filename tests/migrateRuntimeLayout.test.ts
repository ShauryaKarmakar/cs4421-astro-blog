import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dockerfilePath = join(projectRoot, 'dockerfile');

let runtimeDirectory: string | undefined;

afterEach(() => {
  if (runtimeDirectory) {
    rmSync(runtimeDirectory, { recursive: true, force: true });
    runtimeDirectory = undefined;
  }
});

interface RuntimeCopy {
  source: string;
  destination: string;
}

/**
 * Reads the COPY instructions from the Dockerfile's runtime stage so the test
 * verifies the files the image actually ships, not a hand-maintained list.
 */
function readRuntimeCopies(): RuntimeCopy[] {
  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  const runtimeStage = dockerfile.slice(
    dockerfile.lastIndexOf(' AS runtime') + ' AS runtime'.length,
  );
  const copies: RuntimeCopy[] = [];

  for (const line of runtimeStage.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    if (tokens[0] !== 'COPY' || !tokens.includes('--from=build')) {
      continue;
    }

    const paths = tokens.slice(1).filter((token) => !token.startsWith('--'));
    if (paths.length < 2) {
      continue;
    }

    const destination = paths[paths.length - 1];
    for (const source of paths.slice(0, -1)) {
      if (source.startsWith('/app/')) {
        copies.push({ source, destination });
      }
    }
  }

  return copies;
}

function findRuntimeCopy(copies: RuntimeCopy[], source: string): RuntimeCopy {
  const copy = copies.find((entry) => entry.source === source);
  if (!copy) {
    throw new Error(`The runtime image does not copy ${source}.`);
  }
  return copy;
}

function copyIntoRuntimeLayout(copy: RuntimeCopy, targetRoot: string): void {
  const relativeSource = copy.source.replace(/^\/app\//, '');
  const relativeDestination = copy.destination.startsWith('/app/')
    ? copy.destination.slice('/app/'.length)
    : copy.destination.replace(/^\.\//, '');
  const targetRelative = copy.destination.endsWith('/')
    ? join(relativeDestination, basename(relativeSource))
    : relativeDestination;
  const targetPath = join(targetRoot, targetRelative);

  mkdirSync(dirname(targetPath), { recursive: true });
  cpSync(join(projectRoot, relativeSource), targetPath, { recursive: true });
}

describe('migration runner runtime layout', () => {
  it('resolves the shared PostgreSQL config from the Docker runtime stage', () => {
    const copies = readRuntimeCopies();
    const sharedConfig = findRuntimeCopy(
      copies,
      '/app/src/lib/postgresConfig.mjs',
    );

    runtimeDirectory = mkdtempSync(join(tmpdir(), 'unibudget-runtime-'));
    const targetRoot = runtimeDirectory;

    for (const copy of copies) {
      const relativeSource = copy.source.replace(/^\/app\//, '');
      // The migration entry point does not load the built Astro server, and
      // node_modules is linked to keep the test fast.
      if (relativeSource === 'dist' || relativeSource === 'node_modules') {
        continue;
      }
      copyIntoRuntimeLayout(copy, targetRoot);
    }

    symlinkSync(join(projectRoot, 'node_modules'), join(targetRoot, 'node_modules'), 'junction');

    expect(existsSync(join(targetRoot, 'src/lib/postgresConfig.mjs'))).toBe(
      true,
    );

    const environment = { ...process.env };
    for (const name of [
      'APP_DATABASE_PASSWORD',
      'MIGRATION_DATABASE_URL',
      'PGHOST',
      'PGPORT',
      'PGUSER',
      'PGPASSWORD',
      'PGDATABASE',
      'PGSSLMODE',
      'PGSSLROOTCERT',
      'NODE_ENV',
    ]) {
      delete environment[name];
    }

    const result = spawnSync(
      process.execPath,
      ['scripts/migrate.mjs'],
      {
        cwd: targetRoot,
        encoding: 'utf8',
        env: environment,
      },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    // A module-resolution failure means the runtime image is missing a file
    // the migration entry point imports. A missing configuration error is the
    // expected, safe outcome: the runner stops before opening a connection.
    expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(result.status).toBe(1);
    expect(output).toContain('APP_DATABASE_PASSWORD is required');
    expect(sharedConfig.destination).toMatch(
      /src\/lib\/postgresConfig\.mjs$/,
    );
  });
});
