import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createPostgresPoolConfig } from '../src/lib/postgresConfig.mjs';

const migrationDirectory = new URL('../migrations/', import.meta.url);
const migrationPattern = /^\d{2}_[a-z0-9_]+\.sql$/;
const advisoryLockId = 741993104;

const defaultApplicationRole = 'unibudget_app';
// Supabase's Data API roles. They receive default table grants in public for
// tables created by the postgres role, so each migration run removes them from
// the UniBudget tables explicitly.
const supabaseApiRoles = ['anon', 'authenticated', 'service_role'];

const applicationTables = [
  'users',
  'sessions',
  'profiles',
  'transactions',
  'monthly_budgets',
];
const legacyBudgetTable = 'monthly_category_budgets_legacy';
const protectedTables = [...applicationTables, legacyBudgetTable];
const ledgerTable = 'schema_migrations';
const apiProtectedTables = [...protectedTables, ledgerTable];

const applicationPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const verifiablePrivileges = [
  ...applicationPrivileges,
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
];

// The migration that first creates each table. A table that exists before its
// creating migration is recorded is schema drift, not a fresh database.
const tableIntroducedBy = {
  users: '01_init.sql',
  sessions: '01_init.sql',
  profiles: '01_init.sql',
  transactions: '02_create_transactions.sql',
  monthly_budgets: '03_create_monthly_budgets.sql',
  [legacyBudgetTable]: '04_migrate_to_overall_monthly_budgets.sql',
};

const tablesByMigration = {
  '01_init.sql': ['users', 'sessions', 'profiles'],
  '02_create_transactions.sql': ['transactions'],
  '03_create_monthly_budgets.sql': ['monthly_budgets'],
  '04_migrate_to_overall_monthly_budgets.sql': [
    'monthly_budgets',
    legacyBudgetTable,
  ],
};

// Columns every UniBudget table must have once its migration is recorded. This
// catches an incompatible table that CREATE TABLE IF NOT EXISTS would otherwise
// silently accept.
const requiredColumns = {
  users: ['email', 'password_hash'],
  sessions: ['token_hash', 'user_id', 'expires_at'],
  profiles: ['user_id', 'currency', 'timezone'],
  transactions: ['user_id', 'type', 'amount', 'category', 'transaction_date'],
  monthly_budgets: ['user_id', 'budget_month', 'base_amount'],
  [legacyBudgetTable]: ['user_id', 'category', 'budget_month', 'base_amount'],
};

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to run database migrations.`);
  }
  return value;
}

function safeErrorMessage(error) {
  const message =
    error instanceof Error ? error.message : 'Unknown migration error';
  // PostgreSQL errors can echo connection details. Keep diagnostics useful
  // without ever writing a connection URL or password to the task log.
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-connection-string]')
    .replace(/(password\s*[=:]\s*)\S+/gi, '$1[redacted]');
}

function contextualError(message, error) {
  const wrapped = new Error(`${message}: ${safeErrorMessage(error)}`, {
    cause: error,
  });
  if (typeof error === 'object' && error !== null && 'code' in error) {
    wrapped.code = error.code;
  }
  return wrapped;
}

function migrationConnectionString() {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL?.trim();
  if (migrationUrl) {
    return migrationUrl;
  }

  const pgVariables = ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];
  const missing = pgVariables.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Set MIGRATION_DATABASE_URL to the migration/administrator connection, or set all of ${pgVariables.join(', ')}. Missing: ${missing.join(', ')}.`,
    );
  }
  return undefined;
}

function createMigrationPool() {
  const connectionString = migrationConnectionString();
  const config = createPostgresPoolConfig(connectionString);

  // createPostgresPoolConfig() only adds TLS when it is requested. Migrations
  // always require verified TLS, so reject a configuration that would connect
  // without it.
  if (!config.ssl || config.ssl.rejectUnauthorized !== true) {
    throw new Error(
      'Database migrations require verified TLS: set PGSSLMODE=verify-full and PGSSLROOTCERT or SUPABASE_CA_CERT to the trusted PostgreSQL CA certificate.',
    );
  }

  return new Pool({
    ...config,
    // Bound connection acquisition and every statement so a failing pooler,
    // blocked lock, or cancelled ECS task cannot leave the runner hanging.
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
    statement_timeout: 120_000,
    lock_timeout: 30_000,
    idleTimeoutMillis: 30_000,
    application_name: 'unibudget-migrate',
  });
}

export function computeChecksum(sql) {
  // Normalize line endings so a migration applied from a Windows checkout has
  // the same checksum when the Linux container or CI runs it later.
  return createHash('sha256')
    .update(sql.replace(/\r\n?/g, '\n'))
    .digest('hex');
}

export async function loadMigrations(directory = migrationDirectory) {
  const names = (await readdir(directory)).sort();
  const sqlFiles = names.filter((name) => name.endsWith('.sql'));
  const invalidNames = sqlFiles.filter((name) => !migrationPattern.test(name));
  if (invalidNames.length > 0) {
    throw new Error(
      `Invalid migration filenames: ${invalidNames.join(', ')}. Use NN_lower_snake_case.sql.`,
    );
  }

  const entries = [];
  for (const name of sqlFiles) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    entries.push({ name, sql, checksum: computeChecksum(sql) });
  }
  return entries;
}

async function setSafeSearchPath(client) {
  // Unqualified migration objects must be created in public, while
  // uuid_generate_v4() must remain resolvable from Supabase's extensions
  // schema. Nonexistent schemas on the path are ignored by PostgreSQL.
  await client.query('SET search_path = public, extensions, pg_temp');
}

async function readExistingTables(client) {
  const result = await client.query(
    `SELECT table_name
       FROM unnest($1::text[]) AS table_name
      WHERE to_regclass(format('public.%I', table_name)) IS NOT NULL`,
    [protectedTables],
  );
  return result.rows.map((row) => row.table_name);
}

async function readColumns(client, tableNames) {
  if (tableNames.length === 0) {
    return {};
  }

  const result = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [tableNames],
  );
  const columnsByTable = {};
  for (const row of result.rows) {
    columnsByTable[row.table_name] ??= [];
    columnsByTable[row.table_name].push(row.column_name);
  }
  return columnsByTable;
}

async function readLedger(client) {
  const ledger = await client.query(
    `SELECT to_regclass('public.schema_migrations') AS ledger`,
  );
  if (!ledger.rows[0].ledger) {
    return null;
  }

  const checksumColumn = await client.query(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = '${ledgerTable}'
          AND column_name = 'checksum'
     ) AS present`,
  );
  const hasChecksum = checksumColumn.rows[0].present;

  // Read only. Older runners recorded only names; the checksum column is
  // added after preflight succeeds so a rejected run does not mutate the
  // production ledger.
  const applied = await client.query(
    `SELECT name, ${hasChecksum ? 'checksum' : 'NULL::text AS checksum'}
       FROM public.${ledgerTable}
      ORDER BY name`,
  );
  return { rows: applied.rows, hasChecksum };
}

export function evaluatePreflight({
  entries,
  applied,
  existingTables,
  columnsByTable,
}) {
  const errors = [];
  const knownNames = new Set(entries.map((entry) => entry.name));
  const appliedNames = applied.map((record) => record.name);
  const appliedSet = new Set(appliedNames);

  for (const name of appliedNames) {
    if (!knownNames.has(name)) {
      errors.push(
        `The migration ledger contains unknown migration ${name}.`,
      );
    }
  }

  const expectedPrefix = entries
    .slice(0, appliedNames.length)
    .map((entry) => entry.name);
  if (
    appliedNames.length > 0 &&
    appliedNames.some((name, index) => name !== expectedPrefix[index])
  ) {
    errors.push(
      `The migration ledger is not a contiguous prefix of the available migrations (recorded: ${appliedNames.join(', ')}).`,
    );
  }

  for (const record of applied) {
    const entry = entries.find((candidate) => candidate.name === record.name);
    if (record.checksum && entry && record.checksum !== entry.checksum) {
      errors.push(
        `Migration ${record.name} has changed since it was applied; the ledger checksum does not match the file.`,
      );
    }
  }

  for (const name of appliedNames) {
    for (const table of tablesByMigration[name] ?? []) {
      if (!existingTables.includes(table)) {
        errors.push(
          `Migration ${name} is recorded but public.${table} is missing.`,
        );
        continue;
      }
      const columns = new Set(columnsByTable[table] ?? []);
      for (const column of requiredColumns[table] ?? []) {
        if (!columns.has(column)) {
          errors.push(
            `public.${table} is missing column ${column}, which migration ${name} requires.`,
          );
        }
      }
    }
  }

  for (const [table, migration] of Object.entries(tableIntroducedBy)) {
    if (existingTables.includes(table) && !appliedSet.has(migration)) {
      errors.push(
        `public.${table} exists but ${migration} is not recorded in the migration ledger.`,
      );
    }
  }

  if (appliedSet.has('04_migrate_to_overall_monthly_budgets.sql')) {
    if ((columnsByTable.monthly_budgets ?? []).includes('category')) {
      errors.push(
        'public.monthly_budgets still has a category column after migration 04; the overall-budget schema is not in place.',
      );
    }
    if (
      existingTables.includes(legacyBudgetTable) &&
      !(columnsByTable[legacyBudgetTable] ?? []).includes('category')
    ) {
      errors.push(
        `public.${legacyBudgetTable} is missing the archived category column.`,
      );
    }
  }

  return errors;
}

async function createLedger(client) {
  await client.query(`
    CREATE TABLE public.${ledgerTable} (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      checksum TEXT
    )
  `);
}

async function ensureLedgerChecksumColumn(client) {
  await client.query(
    `ALTER TABLE public.${ledgerTable} ADD COLUMN IF NOT EXISTS checksum TEXT`,
  );
}

/**
 * Removes every Data API privilege from the UniBudget tables, including the
 * migration ledger. Supabase grants its API roles privileges on new public
 * tables by default, so this must run in the same transaction as each schema
 * change; otherwise a later failure would leave newly created tables readable
 * through the Data API. Supabase-managed objects and global default ACLs are
 * deliberately left untouched.
 *
 * Returns the quoted role list so the caller can verify the result.
 */
async function revokeDataApiPrivileges(
  client,
  apiRoleNames,
  tables = apiProtectedTables,
) {
  const apiRolesResult = await client.query(
    `SELECT string_agg(format('%I', rolname), ', ') AS roles
       FROM pg_roles
      WHERE rolname = ANY($1::text[])`,
    [apiRoleNames],
  );
  const quotedApiRoles = apiRolesResult.rows[0]?.roles;
  if (!quotedApiRoles) {
    return null;
  }

  const revokes = await client.query(
    `SELECT t.table_name,
            format(
              'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %s',
              'public', t.table_name, $2::text
            ) AS statement
       FROM unnest($1::text[]) AS t(table_name)
      WHERE to_regclass(format('public.%I', t.table_name)) IS NOT NULL`,
    [tables, quotedApiRoles],
  );
  for (const revoke of revokes.rows) {
    try {
      await client.query(revoke.statement);
    } catch (error) {
      throw contextualError(
        `Could not revoke Data API privileges on public.${revoke.table_name}`,
        error,
      );
    }
  }
  return quotedApiRoles;
}

export async function configureApplicationRole(client, password, options = {}) {
  const roleName = options.applicationRole ?? defaultApplicationRole;
  const apiRoleNames = options.apiRoles ?? supabaseApiRoles;

  await client.query('BEGIN');
  try {
    const existingRole = await client.query(
      `SELECT rolsuper,
              rolcreatedb,
              rolcreaterole,
              rolinherit,
              rolcanlogin,
              rolreplication,
              rolbypassrls
         FROM pg_roles
        WHERE rolname = $1`,
      [roleName],
    );
    const role = existingRole.rows[0];

    if (role) {
      const memberships = await client.query(
        `SELECT granted.rolname AS role_name
           FROM pg_auth_members AS membership
           JOIN pg_roles AS granted ON granted.oid = membership.roleid
          WHERE membership.member = (SELECT oid FROM pg_roles WHERE rolname = $1)
          ORDER BY granted.rolname`,
        [roleName],
      );
      if (memberships.rowCount > 0) {
        throw new Error(
          `The application role is a member of these roles: ${memberships.rows
            .map((row) => row.role_name)
            .join(', ')}. Revoke them after reviewing the existing database before migration.`,
        );
      }

      const ownership = await client.query(
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
        [roleName],
      );
      if (ownership.rows[0].owns_schema_objects) {
        throw new Error(
          'The application role owns existing public-schema objects. Review and reassign them before migration.',
        );
      }

      // A non-superuser migration connection (including Supabase's `postgres`
      // role) cannot clear SUPERUSER, CREATEDB, REPLICATION, or BYPASSRLS with
      // ALTER ROLE, so refuse to continue rather than leave an elevated role in
      // place. LOGIN, CREATEROLE, and INHERIT are reset in the ALTER below.
      const elevatedAttributes = [
        role.rolsuper && 'SUPERUSER',
        role.rolcreatedb && 'CREATEDB',
        role.rolreplication && 'REPLICATION',
        role.rolbypassrls && 'BYPASSRLS',
      ].filter(Boolean);
      if (elevatedAttributes.length > 0) {
        throw new Error(
          `The application role has elevated attributes (${elevatedAttributes.join(', ')}). A non-superuser migration connection cannot remove them; correct the role manually before migrating.`,
        );
      }
    }

    // CREATE ROLE accepts the negative attribute clauses for a CREATEROLE user.
    // ALTER ROLE does not: PostgreSQL rejects NOSUPERUSER, NOCREATEDB,
    // NOREPLICATION, and NOBYPASSRLS for a non-superuser even when the role is
    // already unprivileged, so only the attributes we can safely reset are
    // altered and the rest are verified above.
    const roleStatement = role
      ? 'ALTER ROLE %I WITH LOGIN NOCREATEROLE NOINHERIT PASSWORD %L'
      : 'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L';
    const roleSql = await client.query(
      'SELECT format($1::text, $2::text, $3::text) AS statement',
      [roleStatement, roleName, password],
    );
    try {
      await client.query(roleSql.rows[0].statement);
    } catch (error) {
      throw contextualError(
        role
          ? `Could not update the ${roleName} role. The migration connection needs CREATEROLE and, on PostgreSQL 16+, ADMIN OPTION on that role`
          : `Could not create the ${roleName} role. The migration connection needs CREATEROLE`,
        error,
      );
    }

    const databasePrivileges = await client.query(
      `SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), $1::text) AS revoke,
              format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS grant`,
      [roleName],
    );
    try {
      await client.query(databasePrivileges.rows[0].revoke);
      await client.query(databasePrivileges.rows[0].grant);
    } catch (error) {
      throw contextualError(
        'Could not manage database CONNECT privileges for the application role. The migration connection must own the database',
        error,
      );
    }

    const schemaPrivileges = await client.query(
      `SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I', 'public', $1::text) AS revoke_schema,
              format('GRANT USAGE ON SCHEMA %I TO %I', 'public', $1::text) AS grant_usage,
              format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I', 'public', $1::text) AS revoke_tables,
              format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I', 'public', $1::text) AS revoke_sequences`,
      [roleName],
    );
    try {
      for (const key of [
        'revoke_schema',
        'grant_usage',
        'revoke_tables',
        'revoke_sequences',
      ]) {
        await client.query(schemaPrivileges.rows[0][key]);
      }
    } catch (error) {
      throw contextualError(
        'Could not manage public-schema privileges for the application role. The migration connection must own the public schema',
        error,
      );
    }

    for (const table of applicationTables) {
      const grant = await client.query(
        `SELECT format(
           'GRANT ${applicationPrivileges.join(', ')} ON TABLE %I.%I TO %I',
           $1::text, $2::text, $3::text
         ) AS statement`,
        ['public', table, roleName],
      );
      try {
        await client.query(grant.rows[0].statement);
      } catch (error) {
        throw contextualError(
          `Could not grant application privileges on public.${table}`,
          error,
        );
      }
    }

    // Tables added by future migrations receive the same grants automatically.
    // The legacy archive and the migration ledger already exist, so they are
    // not covered by these defaults.
    const defaultPrivileges = await client.query(
      `SELECT format(
         'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ${applicationPrivileges.join(', ')} ON TABLES TO %I',
         'public', $1::text
       ) AS statement`,
      [roleName],
    );
    try {
      await client.query(defaultPrivileges.rows[0].statement);
    } catch (error) {
      throw contextualError(
        'Could not record default privileges for future application tables',
        error,
      );
    }

    // Supabase grants its Data API roles privileges on new public tables by
    // default. Remove them from every UniBudget table, including the migration
    // ledger, inside this transaction.
    const quotedApiRoles = await revokeDataApiPrivileges(client, apiRoleNames);

    const serverVersion = await client.query(
      `SELECT current_setting('server_version_num')::int AS version`,
    );
    const checkedPrivileges = [...verifiablePrivileges];
    if (serverVersion.rows[0].version >= 170000) {
      checkedPrivileges.push('MAINTAIN');
    }

    // has_table_privilege() treats a comma-separated list as "any of these",
    // so verify every privilege individually through a cross join.
    const missingApplicationPrivileges = await client.query(
      `SELECT t.table_name, p.privilege_type
         FROM unnest($1::text[]) AS t(table_name)
         CROSS JOIN unnest($2::text[]) AS p(privilege_type)
        WHERE NOT has_table_privilege(
                $3::text,
                format('public.%I', t.table_name),
                p.privilege_type
              )
        ORDER BY t.table_name, p.privilege_type`,
      [applicationTables, applicationPrivileges, roleName],
    );
    if (missingApplicationPrivileges.rowCount > 0) {
      throw new Error(
        `The application role is missing required privileges: ${missingApplicationPrivileges.rows
          .map((row) => `${row.table_name}.${row.privilege_type}`)
          .join(', ')}`,
      );
    }

    const forbiddenApplicationPrivileges = await client.query(
      `SELECT t.table_name, p.privilege_type
         FROM unnest($1::text[]) AS t(table_name)
         CROSS JOIN unnest($2::text[]) AS p(privilege_type)
        WHERE has_table_privilege(
                $3::text,
                format('public.%I', t.table_name),
                p.privilege_type
              )
        ORDER BY t.table_name, p.privilege_type`,
      [[legacyBudgetTable, ledgerTable], checkedPrivileges, roleName],
    );
    if (forbiddenApplicationPrivileges.rowCount > 0) {
      throw new Error(
        `The application role must not access the archive or migration ledger: ${forbiddenApplicationPrivileges.rows
          .map((row) => `${row.table_name}.${row.privilege_type}`)
          .join(', ')}`,
      );
    }

    if (quotedApiRoles) {
      const remainingApiPrivileges = await client.query(
        `SELECT r.role_name, t.table_name, p.privilege_type
           FROM unnest($1::text[]) AS r(role_name)
           CROSS JOIN unnest($2::text[]) AS t(table_name)
           CROSS JOIN unnest($3::text[]) AS p(privilege_type)
          WHERE has_table_privilege(
                  r.role_name,
                  format('public.%I', t.table_name),
                  p.privilege_type
                )
          ORDER BY r.role_name, t.table_name, p.privilege_type`,
        [apiRoleNames, apiProtectedTables, checkedPrivileges],
      );
      if (remainingApiPrivileges.rowCount > 0) {
        throw new Error(
          `Supabase Data API roles still have privileges on UniBudget tables: ${remainingApiPrivileges.rows
            .map(
              (row) =>
                `${row.role_name}:${row.table_name}.${row.privilege_type}`,
            )
            .join(', ')}`,
        );
      }
    }

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

export async function runMigrations(pool, applicationPassword, options = {}) {
  const roleName = options.applicationRole ?? defaultApplicationRole;
  const apiRoleNames = options.apiRoles ?? supabaseApiRoles;
  const directory = options.migrationDirectory ?? migrationDirectory;

  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await setSafeSearchPath(client);

    const identity = await client.query(
      'SELECT current_user AS role, session_user AS session_role',
    );
    const { role: currentRole, session_role: sessionRole } = identity.rows[0];
    if (currentRole === roleName || sessionRole === roleName) {
      throw new Error(
        `Database migrations must run as a migration/administrator connection, not as ${roleName}.`,
      );
    }

    await client.query('SELECT pg_advisory_lock($1)', [advisoryLockId]);
    lockAcquired = true;

    const entries = await loadMigrations(directory);
    const existingTables = await readExistingTables(client);
    const ledger = await readLedger(client);
    const columnsByTable = await readColumns(client, existingTables);

    const preflightErrors = evaluatePreflight({
      entries,
      applied: ledger?.rows ?? [],
      existingTables,
      columnsByTable,
    });
    if (!ledger && existingTables.length > 0) {
      preflightErrors.unshift(
        'Existing UniBudget tables were found without a migration ledger. Verify the schema and baseline it deliberately before migrating.',
      );
    }
    if (preflightErrors.length > 0) {
      throw new Error(
        `Database preflight failed:\n- ${preflightErrors.join('\n- ')}`,
      );
    }

    // Only mutate the ledger after preflight passed, and do so in a
    // transaction so a failed baseline/upgrade leaves it untouched.
    if (!ledger) {
      await client.query('BEGIN');
      try {
        await createLedger(client);
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Could not create the migration ledger and could not roll back: ${safeErrorMessage(error)}; rollback: ${safeErrorMessage(rollbackError)}`,
          );
        }
        throw contextualError('Could not create the migration ledger', error);
      }
    } else {
      await client.query('BEGIN');
      try {
        if (!ledger.hasChecksum) {
          await ensureLedgerChecksumColumn(client);
        }
        for (const record of ledger.rows) {
          if (!record.checksum) {
            const entry = entries.find(
              (candidate) => candidate.name === record.name,
            );
            if (entry) {
              await client.query(
                `UPDATE public.${ledgerTable} SET checksum = $1 WHERE name = $2`,
                [entry.checksum, record.name],
              );
              process.stdout.write(
                `Recorded checksum for previously applied migration: ${record.name}\n`,
              );
            }
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Could not update the migration ledger and could not roll back: ${safeErrorMessage(error)}; rollback: ${safeErrorMessage(rollbackError)}`,
          );
        }
        throw contextualError('Could not update the migration ledger', error);
      }
    }

    const appliedMigrations = new Set(
      (ledger?.rows ?? []).map((record) => record.name),
    );

    for (const entry of entries) {
      if (appliedMigrations.has(entry.name)) {
        process.stdout.write(`Already applied: ${entry.name}\n`);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(
          'SET LOCAL search_path = public, extensions, pg_temp',
        );
        await client.query(entry.sql);
        // Fail closed: the Data API revoke is committed atomically with the
        // schema change, so a later migration failure cannot leave the new
        // tables exposed.
        await revokeDataApiPrivileges(client, apiRoleNames);
        await client.query(
          `INSERT INTO public.${ledgerTable} (name, checksum) VALUES ($1, $2)`,
          [entry.name, entry.checksum],
        );
        await client.query('COMMIT');
        process.stdout.write(`Applied: ${entry.name}\n`);
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Migration ${entry.name} failed and could not be rolled back: ${safeErrorMessage(error)}; rollback: ${safeErrorMessage(rollbackError)}`,
          );
        }
        throw contextualError(`Migration ${entry.name} failed`, error);
      }
    }

    const finalTables = await readExistingTables(client);
    const missingTables = protectedTables.filter(
      (table) => !finalTables.includes(table),
    );
    if (missingTables.length > 0) {
      throw new Error(
        `Migration run completed without the expected tables: ${missingTables.join(', ')}`,
      );
    }

    await configureApplicationRole(client, applicationPassword, {
      applicationRole: roleName,
      apiRoles: apiRoleNames,
    });
    process.stdout.write('Application database role permissions are current.\n');
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockId]);
      } catch (error) {
        process.stderr.write(
          `Warning: could not release the migration advisory lock: ${safeErrorMessage(error)}\n`,
        );
      }
    }
    try {
      client.release();
    } catch (error) {
      process.stderr.write(
        `Warning: could not release the migration database client: ${safeErrorMessage(error)}\n`,
      );
    }
  }
}

export async function main() {
  let pool;

  // ECS sends SIGTERM when a stopped or timed-out task is cancelled. Exit
  // immediately so the open transaction is rolled back by PostgreSQL and the
  // session-level advisory lock is released with the connection instead of
  // letting a cancelled task keep migrating.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      process.stderr.write(
        `Database migration received ${signal}; aborting without committing further changes.\n`,
      );
      process.exit(1);
    });
  }

  try {
    const applicationPassword = requiredEnvironment('APP_DATABASE_PASSWORD');
    pool = createMigrationPool();
    pool.on('error', (error) => {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? ` (${String(error.code)})`
          : '';
      const name =
        error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
          ? error.name
          : 'Error';
      process.stderr.write(
        `Migration database pool idle error: ${name}${code}\n`,
      );
    });
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
    if (pool) {
      try {
        await pool.end();
      } catch (error) {
        process.stderr.write(
          `Warning: could not close the migration pool: ${safeErrorMessage(error)}\n`,
        );
      }
    }
  }
}

const isEntryPoint =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntryPoint) {
  await main();
}
