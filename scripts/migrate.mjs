import { readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

const migrationDirectory = new URL('../migrations/', import.meta.url);
const migrationPattern = /^\d{2}_[a-z0-9_]+\.sql$/;
const advisoryLockId = 741993104;
const applicationRole = 'unibudget_app';
const applicationTables = [
  'users',
  'sessions',
  'profiles',
  'transactions',
  'monthly_budgets',
];

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to run database migrations.`);
  }
  return value;
}

function createMigrationPool() {
  const host = requiredEnvironment('MIGRATION_PGHOST');
  const user = requiredEnvironment('MIGRATION_PGUSER');
  const password = requiredEnvironment('MIGRATION_PGPASSWORD');
  const database = requiredEnvironment('MIGRATION_PGDATABASE');
  const caPath = requiredEnvironment('MIGRATION_PGSSLROOTCERT');
  if (process.env.MIGRATION_PGSSLMODE !== 'verify-full') {
    throw new Error('MIGRATION_PGSSLMODE must be verify-full.');
  }
  const port = Number(process.env.MIGRATION_PGPORT ?? '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MIGRATION_PGPORT must be a valid TCP port.');
  }

  return new Pool({
    host,
    port,
    user,
    password,
    database,
    ssl: {
      ca: readFileSync(caPath),
      rejectUnauthorized: true,
    },
  });
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : 'Unknown migration error';
}

async function configureApplicationRole(client, password) {
  await client.query('BEGIN');
  try {
    const roleExists = await client.query(
      'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
      [applicationRole],
    );
    if (roleExists.rows[0].exists) {
      const roleMembership = await client.query(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_auth_members
           WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)
         ) AS has_memberships`,
        [applicationRole],
      );
      if (roleMembership.rows[0].has_memberships) {
        throw new Error(
          'The application role has inherited role memberships. Revoke them after reviewing the existing database before migration.',
        );
      }
      const roleOwnership = await client.query(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_class AS relation
           JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = 'public'
             AND relation.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
         ) OR EXISTS (
           SELECT 1
           FROM pg_namespace
           WHERE nspname = 'public'
             AND nspowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
         ) AS owns_schema_objects`,
        [applicationRole],
      );
      if (roleOwnership.rows[0].owns_schema_objects) {
        throw new Error(
          'The application role owns existing public-schema objects. Review and reassign them before migration.',
        );
      }
    }
    const roleStatement = await client.query(
      `SELECT format(
         CASE WHEN $1 THEN 'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L'
              ELSE 'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L'
         END,
         $2::text, $3::text
       ) AS statement`,
      [roleExists.rows[0].exists, applicationRole, password],
    );
    await client.query(roleStatement.rows[0].statement);

    const databasePrivileges = await client.query(
      `SELECT format(
         'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I; GRANT CONNECT ON DATABASE %I TO %I',
         current_database(), $1::text, current_database(), $1::text
       ) AS statement`,
      [applicationRole],
    );
    await client.query(databasePrivileges.rows[0].statement);
    await client.query(
      `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${applicationRole};
       GRANT USAGE ON SCHEMA public TO ${applicationRole};
       REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${applicationRole};
       REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${applicationRole}`,
    );

    for (const table of applicationTables) {
      const grant = await client.query(
        'SELECT format(\'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I\', $1::text, $2::text, $3::text) AS statement',
        ['public', table, applicationRole],
      );
      await client.query(grant.rows[0].statement);
    }

    const defaults = await client.query(
      `SELECT format(
         'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
         $1::text, $2::text
       ) AS statement`,
      ['public', applicationRole],
    );
    await client.query(defaults.rows[0].statement);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Application database role setup failed and could not be rolled back: ${safeErrorMessage(error)}; rollback: ${safeErrorMessage(rollbackError)}`,
      );
    }
    throw error;
  }
}

async function runMigrations(pool, applicationPassword) {
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [advisoryLockId]);
    lockAcquired = true;

    const state = await client.query(
      `SELECT to_regclass('schema_migrations') AS ledger,
              to_regclass('users') AS users`,
    );
    if (!state.rows[0].ledger && state.rows[0].users) {
      throw new Error(
        'Existing users table found without a migration ledger. Verify the database schema and baseline it deliberately before migrating.',
      );
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const entries = (await readdir(migrationDirectory))
      .filter((name) => migrationPattern.test(name))
      .sort();
    const knownMigrations = new Set(entries);
    const appliedResult = await client.query('SELECT name FROM schema_migrations');
    const appliedMigrations = new Set(
      appliedResult.rows.map((row) => row.name),
    );
    const unknownMigrations = [...appliedMigrations].filter(
      (name) => !knownMigrations.has(name),
    );
    if (unknownMigrations.length > 0) {
      throw new Error(
        `Database migration ledger contains unknown migrations: ${unknownMigrations.join(', ')}`,
      );
    }

    for (const name of entries) {
      if (appliedMigrations.has(name)) {
        process.stdout.write(`Already applied: ${name}\n`);
        continue;
      }

      const sql = await readFile(new URL(name, migrationDirectory), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        process.stdout.write(`Applied: ${name}\n`);
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Migration ${name} failed and could not be rolled back: ${safeErrorMessage(error)}; rollback: ${safeErrorMessage(rollbackError)}`,
          );
        }
        throw error;
      }
    }

    await configureApplicationRole(client, applicationPassword);
    process.stdout.write('Application database role permissions are current.\n');
  } finally {
    if (lockAcquired) {
      await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockId]);
    }
    client.release();
  }
}

let pool;
try {
  const applicationPassword = requiredEnvironment('APP_DATABASE_PASSWORD');
  pool = createMigrationPool();
  await runMigrations(pool, applicationPassword);
} catch (error) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? ` (${String(error.code)})`
      : '';
  process.stderr.write(
    `Database migration failed${code}: ${safeErrorMessage(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
