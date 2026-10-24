import { readFileSync } from 'node:fs';

const sslQueryParameters = [
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslpassword',
  'ssl',
];

/**
 * @param {string} connectionString
 * @returns {{ connectionString: string, sslMode?: string }}
 */
function removeConnectionStringTlsParameters(connectionString) {
  let parsed;
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
      'Configure PostgreSQL TLS with PGSSLROOTCERT or SUPABASE_CA_CERT, not TLS options in the connection URL.',
    );
  }

  parsed.searchParams.delete('sslmode');
  return { connectionString: parsed.toString(), sslMode };
}

/**
 * Build a `pg` pool configuration that only ever verifies PostgreSQL TLS with
 * a trusted CA. The CA may be supplied inline by SUPABASE_CA_CERT (used by the
 * ECS tasks, where the certificate is injected from Secrets Manager) or read
 * from the file named by PGSSLROOTCERT (local development). Shared by the
 * Astro application and the database migration runner.
 *
 * @param {string | undefined} connectionString
 * @param {Record<string, string | undefined>} [env]
 * @param {import('pg').PoolConfig} [poolOptions] additional non-TLS pool options
 * @returns {import('pg').PoolConfig}
 */
export function createPostgresPoolConfig(
  connectionString,
  env = process.env,
  poolOptions = {},
) {
  let safeConnectionString = connectionString;
  let urlSslMode;
  if (safeConnectionString) {
    const sanitized = removeConnectionStringTlsParameters(safeConnectionString);
    safeConnectionString = sanitized.connectionString;
    urlSslMode = sanitized.sslMode;
  }

  const sslMode = env.PGSSLMODE ?? urlSslMode;
  const caPath = env.PGSSLROOTCERT;
  const caCertificate = env.SUPABASE_CA_CERT?.trim();
  const tlsRequired =
    env.NODE_ENV === 'production' ||
    sslMode !== undefined ||
    caPath !== undefined ||
    caCertificate !== undefined;

  if (!tlsRequired) {
    return {
      ...poolOptions,
      ...(safeConnectionString ? { connectionString: safeConnectionString } : {}),
    };
  }

  if (sslMode !== 'verify-full') {
    throw new Error(
      'PostgreSQL TLS must use PGSSLMODE=verify-full; insecure or unverified modes are not supported.',
    );
  }
  if (!caPath && !caCertificate) {
    throw new Error(
      'Provide the trusted PostgreSQL CA with SUPABASE_CA_CERT or PGSSLROOTCERT when TLS verification is enabled.',
    );
  }
  if (
    caCertificate &&
    !caCertificate.includes('-----BEGIN CERTIFICATE-----')
  ) {
    throw new Error(
      'SUPABASE_CA_CERT must contain a PEM-encoded CA certificate.',
    );
  }

  return {
    ...poolOptions,
    ...(safeConnectionString ? { connectionString: safeConnectionString } : {}),
    ssl: {
      ca: caCertificate ?? readFileSync(caPath),
      rejectUnauthorized: true,
    },
  };
}
