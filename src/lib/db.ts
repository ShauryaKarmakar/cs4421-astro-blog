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

/**
 * Raised when the database configuration is absent or invalid. It is thrown
 * when a query runs, not while this module is imported: a throwing import
 * turns every route, including /api/health, into an opaque 500 and hides the
 * outage the health probe exists to report.
 */
export class DatabaseConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DatabaseConfigurationError';
  }
}

/**
 * Converts any configuration failure into the typed error, so an invalid TLS
 * mode or a missing CA certificate is reported the same way as absent
 * configuration instead of escaping during module evaluation.
 */
function toConfigurationError(error: unknown): DatabaseConfigurationError {
  if (error instanceof DatabaseConfigurationError) {
    return error;
  }
  return new DatabaseConfigurationError(
    error instanceof Error
      ? error.message
      : 'The database configuration is invalid.',
    { cause: error },
  );
}

const configurationError =
  connectionString || hasPostgresEnvironment
    ? null
    : new DatabaseConfigurationError(
        'Set DATABASE_URL or complete PostgreSQL environment variables.',
      );

/**
 * The fail-closed contract: every database call rejects with the captured
 * configuration error. It is declared explicitly so the stand-in cannot drift
 * from what callers are promised, without pretending to be a full `pg.Pool`.
 */
type FailClosedPool = {
  query: () => Promise<never>;
  connect: () => Promise<never>;
  on: (event: string, listener: (error: Error) => void) => FailClosedPool;
};

/**
 * Stands in for a connection pool when configuration is absent or invalid.
 * Queries and client checkout fail closed with the configuration error; no
 * connection is attempted or retried, and TLS is never downgraded to reach the
 * database.
 */
function unconfiguredPool(error: DatabaseConfigurationError): Pool {
  const unavailable: FailClosedPool = {
    query: () => Promise.reject(error),
    connect: () => Promise.reject(error),
    on: () => unavailable,
  };

  // The literal above is type-checked against every method callers use; this
  // boundary cast only reconciles the partial stand-in with the `Pool` type
  // the application imports, which it deliberately does not fully implement.
  return unavailable as unknown as Pool;
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

/**
 * Builds a connection pool, turning configuration failures into a pool that
 * rejects every query. Configuration problems surface when a query runs, never
 * while this module is imported, so an invalid TLS mode or CA path cannot take
 * down the health endpoint that reports it.
 */
function createPool(options: PoolConfig): Pool {
  if (configurationError) {
    return unconfiguredPool(configurationError);
  }

  try {
    return new Pool(
      createPostgresPoolConfig(connectionString, process.env, options),
    );
  } catch (error) {
    return unconfiguredPool(toConfigurationError(error));
  }
}

export const pool = createPool(applicationPoolOptions);

export const healthPool = createPool(healthPoolOptions);

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
