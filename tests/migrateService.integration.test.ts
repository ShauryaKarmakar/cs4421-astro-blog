import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolConfig } from 'pg';
import { runMigrations } from '../scripts/migrate.mjs';

const databaseUrl =
  process.env.MIGRATION_TEST_DATABASE_URL ??
  process.env.BUDGET_TEST_DATABASE_URL;
const isCi = process.env.CI === 'true';
if (isCi && !databaseUrl) {
  throw new Error(
    'MIGRATION_TEST_DATABASE_URL is required in CI; the migration integration suite must not be skipped.',
  );
}
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', 'postgres']);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.pathname !== '/unibudget_test' ||
    !allowedHosts.has(parsed.hostname)
  ) {
    throw new Error(
      'The migration integration test requires the unibudget_test database on a local PostgreSQL host or the CI postgres service.',
    );
  }
}

const databaseDescribe = databaseUrl ? describe : describe.skip;
const apiRoles = ['anon', 'authenticated', 'service_role'];
const applicationPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const protectedTables = [
  'users',
  'sessions',
  'profiles',
  'transactions',
  'monthly_budgets',
  'monthly_category_budgets_legacy',
  'schema_migrations',
];

function randomName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

// `DROP DATABASE ... WITH (FORCE)` can terminate a socket that is still
// closing after `pool.end()` resolved, which pg reports as 57P01. That is an
// expected part of teardown; any other pool error still fails the suite.
let teardownStarted = false;

function createPool(config: PoolConfig): Pool {
  const pool = new Pool(config);
  pool.on('error', (error: Error & { code?: string }) => {
    if (teardownStarted && error.code === '57P01') return;
    throw error;
  });
  return pool;
}

databaseDescribe('migration runner against disposable PostgreSQL', () => {
  const createdDatabases: string[] = [];
  const createdRoles: string[] = [];
  const roleName = randomName('unibudget_app_it');
  const password = `test-only-${randomUUID()}`;
  let adminPool: Pool | undefined;
  let applicationPool: Pool | undefined;
  let primaryDatabase = '';

  async function createDatabase(): Promise<string> {
    const name = randomName('unibudget_migration_it');
    await adminPool!.query(`CREATE DATABASE "${name}"`);
    createdDatabases.push(name);
    return name;
  }

  beforeAll(async () => {
    if (!databaseUrl) return;

    adminPool = createPool({ connectionString: databaseUrl, max: 1 });
    const existingRoles = await adminPool.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
      [apiRoles],
    );
    const existingNames = new Set(existingRoles.rows.map((row) => row.rolname));
    for (const role of apiRoles.filter((name) => !existingNames.has(name))) {
      await adminPool.query(`CREATE ROLE "${role}"`);
      createdRoles.push(role);
    }

    primaryDatabase = await createDatabase();
    applicationPool = createPool({
      connectionString: databaseUrlFor(primaryDatabase),
      max: 1,
    });

    // Simulate Supabase's default table grants to its Data API roles.
    await applicationPool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
         TO anon, authenticated, service_role`,
    );
  }, 60_000);

  afterAll(async () => {
    teardownStarted = true;
    await applicationPool?.end();
    if (adminPool) {
      for (const name of createdDatabases) {
        await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
      for (const role of [roleName, ...createdRoles]) {
        await adminPool.query(`DROP ROLE IF EXISTS "${role}"`);
      }
      await adminPool.end();
    }
  }, 60_000);

  it('provisions least privilege, removes Data API access, and reruns safely', async () => {
    if (!applicationPool) throw new Error('Test database was not initialized.');

    await runMigrations(applicationPool, password, {
      applicationRole: roleName,
    });

    const ledger = await applicationPool.query<{
      name: string;
      checksum: string | null;
    }>('SELECT name, checksum FROM public.schema_migrations ORDER BY name');
    expect(ledger.rows.map((row) => row.name)).toEqual([
      '01_init.sql',
      '02_create_transactions.sql',
      '03_create_monthly_budgets.sql',
      '04_migrate_to_overall_monthly_budgets.sql',
    ]);
    expect(ledger.rows.every((row) => row.checksum?.length === 64)).toBe(true);

    const missingApplicationPrivileges = await applicationPool.query(
      `SELECT t.table_name, p.privilege_type
         FROM unnest($1::text[]) AS t(table_name)
         CROSS JOIN unnest($2::text[]) AS p(privilege_type)
        WHERE NOT has_table_privilege(
                $3::text,
                format('public.%I', t.table_name),
                p.privilege_type
              )`,
      [protectedTables.slice(0, 5), applicationPrivileges, roleName],
    );
    expect(missingApplicationPrivileges.rows).toEqual([]);

    const apiPrivileges = await applicationPool.query(
      `SELECT r.role_name, t.table_name, p.privilege_type
         FROM unnest($1::text[]) AS r(role_name)
         CROSS JOIN unnest($2::text[]) AS t(table_name)
         CROSS JOIN unnest($3::text[]) AS p(privilege_type)
        WHERE has_table_privilege(
                r.role_name,
                format('public.%I', t.table_name),
                p.privilege_type
              )`,
      [
        apiRoles,
        protectedTables,
        [...applicationPrivileges, 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
      ],
    );
    expect(apiPrivileges.rows).toEqual([]);

    const forbiddenApplicationPrivileges = await applicationPool.query(
      `SELECT t.table_name, p.privilege_type
         FROM unnest($1::text[]) AS t(table_name)
         CROSS JOIN unnest($2::text[]) AS p(privilege_type)
        WHERE has_table_privilege(
                $3::text,
                format('public.%I', t.table_name),
                p.privilege_type
              )`,
      [
        ['monthly_category_budgets_legacy', 'schema_migrations'],
        [...applicationPrivileges, 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
        roleName,
      ],
    );
    expect(forbiddenApplicationPrivileges.rows).toEqual([]);

    const role = await applicationPool.query<{
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcanlogin: boolean;
      rolinherit: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolsuper, rolcreaterole, rolcanlogin, rolinherit, rolbypassrls
         FROM pg_roles WHERE rolname = $1`,
      [roleName],
    );
    expect(role.rows[0]).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcanlogin: true,
      rolinherit: false,
      rolbypassrls: false,
    });

    await runMigrations(applicationPool, password, {
      applicationRole: roleName,
    });
    const rerunLedger = await applicationPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.schema_migrations',
    );
    expect(rerunLedger.rows[0].count).toBe('4');
  }, 60_000);

  it('refuses a changed migration checksum', async () => {
    if (!applicationPool) throw new Error('Test database was not initialized.');

    await applicationPool.query(
      `UPDATE public.schema_migrations
          SET checksum = repeat('0', 64)
        WHERE name = '01_init.sql'`,
    );

    await expect(
      runMigrations(applicationPool, password, {
        applicationRole: roleName,
      }),
    ).rejects.toThrow(/checksum does not match/);
  }, 30_000);

  it('keeps Data API privileges revoked when a later migration fails', async () => {
    if (!adminPool) throw new Error('Admin database was not initialized.');

    const directory = mkdtempSync(join(tmpdir(), 'unibudget-failing-migration-'));
    const failingDatabase = await createDatabase();
    const failingPool = createPool({
      connectionString: databaseUrlFor(failingDatabase),
      max: 1,
    });
    try {
      for (const name of [
        '01_init.sql',
        '02_create_transactions.sql',
        '03_create_monthly_budgets.sql',
        '04_migrate_to_overall_monthly_budgets.sql',
      ]) {
        copyFileSync(join('migrations', name), join(directory, name));
      }
      writeFileSync(
        join(directory, '05_create_exposed.sql'),
        `CREATE TABLE public.exposed_by_failed_migration (id integer PRIMARY KEY);
         DO $$ BEGIN RAISE EXCEPTION 'intentional test failure'; END $$;`,
      );

      await expect(
        runMigrations(failingPool, password, {
          applicationRole: roleName,
          migrationDirectory: pathToFileURL(`${directory}${sep}`),
        }),
      ).rejects.toThrow(/intentional test failure/);

      const exposed = await failingPool.query<{ table: string | null }>(
        `SELECT to_regclass('public.exposed_by_failed_migration')::text AS table`,
      );
      expect(exposed.rows[0].table).toBeNull();

      // Migrations 01-04 committed, but every commit also revoked Data API
      // access, so a failed run cannot leave those tables readable.
      const remainingApiPrivileges = await failingPool.query(
        `SELECT r.role_name, t.table_name, p.privilege_type
           FROM unnest($1::text[]) AS r(role_name)
           CROSS JOIN unnest($2::text[]) AS t(table_name)
           CROSS JOIN unnest($3::text[]) AS p(privilege_type)
          WHERE has_table_privilege(
                  r.role_name,
                  format('public.%I', t.table_name),
                  p.privilege_type
                )`,
        [
          apiRoles,
          protectedTables,
          [...applicationPrivileges, 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
        ],
      );
      expect(remainingApiPrivileges.rows).toEqual([]);
    } finally {
      await failingPool.end();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses existing UniBudget tables without a migration ledger', async () => {
    if (!adminPool) throw new Error('Admin database was not initialized.');

    const driftDatabase = await createDatabase();
    const driftPool = createPool({
      connectionString: databaseUrlFor(driftDatabase),
      max: 1,
    });
    try {
      await driftPool.query(
        'CREATE TABLE public.users (id integer PRIMARY KEY)',
      );
      await expect(
        runMigrations(driftPool, password, { applicationRole: roleName }),
      ).rejects.toThrow(/without a migration ledger/);

      // Preflight must be read-only: a rejected run cannot create or alter the
      // ledger before validation passes.
      const ledger = await driftPool.query<{ ledger: string | null }>(
        `SELECT to_regclass('public.schema_migrations')::text AS ledger`,
      );
      expect(ledger.rows[0].ledger).toBeNull();
    } finally {
      await driftPool.end();
    }
  }, 30_000);
});
