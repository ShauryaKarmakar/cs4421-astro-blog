import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPostgresPoolConfig } from '../src/lib/postgresConfig';

let temporaryDirectory: string | undefined;

afterEach(() => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

function createCaFile() {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'unibudget-ca-'));
  const caPath = join(temporaryDirectory, 'rds-ca.pem');
  writeFileSync(caPath, 'test CA certificate');
  return caPath;
}

describe('PostgreSQL connection TLS configuration', () => {
  it('requires verified TLS and a CA bundle in production', () => {
    expect(() =>
      createPostgresPoolConfig(undefined, {
        NODE_ENV: 'production',
      }),
    ).toThrow(/PGSSLMODE=verify-full/);

    expect(() =>
      createPostgresPoolConfig(undefined, {
        NODE_ENV: 'production',
        PGSSLMODE: 'verify-full',
      }),
    ).toThrow(/PGSSLROOTCERT/);
  });

  it('loads the trusted CA and enables certificate and hostname verification', () => {
    const caPath = createCaFile();
    const config = createPostgresPoolConfig(
      'postgresql://db.example.test:5432/unibudget?sslmode=verify-full',
      {
        NODE_ENV: 'production',
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: caPath,
      },
    );

    expect(config.ssl).toMatchObject({
      ca: Buffer.from('test CA certificate'),
      rejectUnauthorized: true,
    });
    expect(config.ssl).not.toHaveProperty('checkServerIdentity');
    expect(config.connectionString).toBe(
      'postgresql://db.example.test:5432/unibudget',
    );
  });

  it.each(['disable', 'prefer', 'require', 'no-verify'])(
    'rejects the %s TLS mode',
    (sslMode) => {
      expect(() =>
        createPostgresPoolConfig(undefined, {
          PGSSLMODE: sslMode,
          PGSSLROOTCERT: createCaFile(),
        }),
      ).toThrow(/verify-full/);
    },
  );

  it('rejects insecure TLS options embedded in a connection URL', () => {
    expect(() =>
      createPostgresPoolConfig(
        'postgresql://db.example.test/unibudget?sslmode=disable',
        { PGSSLROOTCERT: createCaFile() },
      ),
    ).toThrow(/verify-full/);

    expect(() =>
      createPostgresPoolConfig(
        'postgresql://db.example.test/unibudget?sslrootcert=system',
        { PGSSLMODE: 'verify-full', PGSSLROOTCERT: createCaFile() },
      ),
    ).toThrow(/PGSSLROOTCERT/);
  });

  it('keeps non-production local PostgreSQL configuration usable without TLS settings', () => {
    expect(
      createPostgresPoolConfig('postgresql://localhost/unibudget', {
        NODE_ENV: 'development',
      }),
    ).toEqual({ connectionString: 'postgresql://localhost/unibudget' });
  });
});
