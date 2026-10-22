import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';

const sslQueryParameters = [
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslpassword',
  'ssl',
];

function removeConnectionStringTlsParameters(connectionString: string): {
  connectionString: string;
  sslMode?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
  }

  const sslMode = parsed.searchParams.get('sslmode') ?? undefined;
  if (sslMode && sslMode !== 'verify-full') {
    throw new Error('PostgreSQL connection URLs may only use sslmode=verify-full.');
  }
  if (sslQueryParameters.some((parameter) => parsed.searchParams.has(parameter))) {
    throw new Error(
      'Configure PostgreSQL TLS with PGSSLROOTCERT, not TLS options in DATABASE_URL.',
    );
  }

  parsed.searchParams.delete('sslmode');
  return { connectionString: parsed.toString(), sslMode };
}

export function createPostgresPoolConfig(
  connectionString: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  let safeConnectionString = connectionString;
  let urlSslMode: string | undefined;
  if (safeConnectionString) {
    const sanitized = removeConnectionStringTlsParameters(safeConnectionString);
    safeConnectionString = sanitized.connectionString;
    urlSslMode = sanitized.sslMode;
  }

  const sslMode = env.PGSSLMODE ?? urlSslMode;
  const caPath = env.PGSSLROOTCERT;
  const tlsRequired =
    env.NODE_ENV === 'production' || sslMode !== undefined || caPath !== undefined;

  if (!tlsRequired) {
    return safeConnectionString
      ? { connectionString: safeConnectionString }
      : {};
  }

  if (sslMode !== 'verify-full') {
    throw new Error(
      'PostgreSQL TLS must use PGSSLMODE=verify-full; insecure or unverified modes are not supported.',
    );
  }
  if (!caPath) {
    throw new Error(
      'PGSSLROOTCERT must point to the trusted PostgreSQL CA bundle when TLS verification is enabled.',
    );
  }

  return {
    ...(safeConnectionString ? { connectionString: safeConnectionString } : {}),
    ssl: {
      ca: readFileSync(caPath),
      rejectUnauthorized: true,
    },
  };
}
