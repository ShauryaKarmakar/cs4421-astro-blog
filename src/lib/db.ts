// src/lib/db.ts
import { Pool, type PoolConfig } from 'pg';
import { createPostgresPoolConfig } from './postgresConfig';
import { logServerError } from './serverLogger';

// Astro loads .env into import.meta.env at build time. Reading it there would
// inline local credentials into the server bundle, so only runtime process
// environment variables are used. `astro dev` is development; load .env into
// process.env explicitly in that mode to keep local development convenient.
if (
  process.env.NODE_ENV === 'development' &&
  !process.env.DATABASE_URL &&
  !process.env.PGHOST &&
  !process.env.PGUSER &&
  !process.env.PGPASSWORD &&
  !process.env.PGDATABASE
) {
  try {
    process.loadEnvFile?.();
  } catch {
    // .env is optional; the missing-configuration error below is clearer.
  }
}

const connectionString = process.env.DATABASE_URL;
const hasPostgresEnvironment = Boolean(
  process.env.PGHOST &&
  process.env.PGUSER &&
  process.env.PGPASSWORD &&
  process.env.PGDATABASE,
);

if (!connectionString && !hasPostgresEnvironment) {
  throw new Error('Set DATABASE_URL or complete PostgreSQL environment variables.');
}

export const applicationDatabaseRole = 'unibudget_app';

const applicationPoolOptions: PoolConfig = {
  connectionTimeoutMillis: 5_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
  idleTimeoutMillis: 30_000,
  application_name: 'unibudget-app',
};

// Health and role checks use their own tiny, short-timeout pool so they cannot
// consume the application's business-query capacity or hang a readiness probe.
const healthPoolOptions: PoolConfig = {
  max: 1,
  connectionTimeoutMillis: 2_000,
  query_timeout: 2_500,
  statement_timeout: 2_000,
  idleTimeoutMillis: 10_000,
  application_name: 'unibudget-health',
};

export const pool = new Pool(
  createPostgresPoolConfig(connectionString, process.env, applicationPoolOptions),
);

export const healthPool = new Pool(
  createPostgresPoolConfig(connectionString, process.env, healthPoolOptions),
);

// Idle clients can emit errors (for example when Supavisor closes a connection).
// Without a listener Node treats that as an unhandled error and terminates the
// process. The logger records only an error name and SQLSTATE, never values.
pool.on('error', (error) => {
  logServerError('db.pool.idle_client_error', error);
});
healthPool.on('error', (error) => {
  logServerError('db.health_pool.idle_client_error', error);
});

let roleAssertion: Promise<void> | null = null;

/**
 * Fails closed when the production application is connected as any role other
 * than the dedicated unibudget_app role. The result is cached after the first
 * successful check; a failure is retried on the next request. The health pool
 * has a two-second server-side statement timeout, so this cannot hang
 * indefinitely.
 */
export async function assertApplicationRole(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  if (!roleAssertion) {
    roleAssertion = healthPool
      .query<{ role: string }>('SELECT current_user AS role')
      .then((result) => {
        const role = result.rows[0]?.role;
        if (role !== applicationDatabaseRole) {
          throw new Error(
            `The application connected as ${role ?? 'an unknown role'} instead of ${applicationDatabaseRole}.`,
          );
        }
      })
      .catch((error: unknown) => {
        roleAssertion = null;
        throw error;
      });
  }

  await roleAssertion;
}

export default pool;
