import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeChecksum,
  evaluatePreflight,
  loadMigrations,
} from '../scripts/migrate.mjs';

let temporaryDirectory: string | undefined;

afterEach(() => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

const allTables = [
  'users',
  'sessions',
  'profiles',
  'transactions',
  'monthly_budgets',
  'monthly_category_budgets_legacy',
];

const allColumns: Record<string, string[]> = {
  users: ['email', 'password_hash'],
  sessions: ['token_hash', 'user_id', 'expires_at'],
  profiles: ['user_id', 'currency', 'timezone'],
  transactions: ['user_id', 'type', 'amount', 'category', 'transaction_date'],
  monthly_budgets: ['user_id', 'budget_month', 'base_amount'],
  monthly_category_budgets_legacy: [
    'user_id',
    'category',
    'budget_month',
    'base_amount',
  ],
};

describe('migration checksums', () => {
  it('is stable for the same SQL and changes with the SQL', () => {
    expect(computeChecksum('SELECT 1;')).toHaveLength(64);
    expect(computeChecksum('SELECT 1;')).toBe(computeChecksum('SELECT 1;'));
    expect(computeChecksum('SELECT 1;')).not.toBe(computeChecksum('SELECT 2;'));
    expect(computeChecksum('SELECT 1;\r\n')).toBe(
      computeChecksum('SELECT 1;\n'),
    );
  });

  it('loads the four migrations in order with checksums', async () => {
    const entries = await loadMigrations();

    expect(entries.map((entry) => entry.name)).toEqual([
      '01_init.sql',
      '02_create_transactions.sql',
      '03_create_monthly_budgets.sql',
      '04_migrate_to_overall_monthly_budgets.sql',
    ]);
    expect(entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.checksum))).toBe(
      true,
    );
  });

  it('rejects unexpected SQL filenames instead of silently skipping them', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'unibudget-migrations-'));
    writeFileSync(join(temporaryDirectory, '01_init.sql'), 'SELECT 1;');
    writeFileSync(join(temporaryDirectory, '02_Bad-Name.sql'), 'SELECT 2;');

    await expect(
      loadMigrations(
        pathToFileURL(`${temporaryDirectory}${sep}`) as URL,
      ),
    ).rejects.toThrow(/Invalid migration filenames: 02_Bad-Name\.sql/);
  });
});

describe('migration preflight', () => {
  it('accepts a fresh database and a fully applied schema', async () => {
    const entries = await loadMigrations();
    const applied = entries.map((entry) => ({
      name: entry.name,
      checksum: entry.checksum,
    }));

    expect(
      evaluatePreflight({
        entries,
        applied: [],
        existingTables: [],
        columnsByTable: {},
      }),
    ).toEqual([]);

    expect(
      evaluatePreflight({
        entries,
        applied,
        existingTables: allTables,
        columnsByTable: allColumns,
      }),
    ).toEqual([]);
  });

  it('detects application tables that exist before their migration is recorded', async () => {
    const entries = await loadMigrations();

    const errors = evaluatePreflight({
      entries,
      applied: [],
      existingTables: ['users'],
      columnsByTable: { users: allColumns.users },
    });

    expect(errors).toContain(
      'public.users exists but 01_init.sql is not recorded in the migration ledger.',
    );
  });

  it('detects a missing table and a missing required column', async () => {
    const entries = await loadMigrations();
    const applied = [
      { name: '01_init.sql', checksum: entries[0]?.checksum ?? '' },
    ];

    const missingTable = evaluatePreflight({
      entries,
      applied,
      existingTables: ['users', 'profiles'],
      columnsByTable: {
        users: allColumns.users,
        profiles: allColumns.profiles,
      },
    });
    expect(missingTable).toContain(
      'Migration 01_init.sql is recorded but public.sessions is missing.',
    );

    const missingColumn = evaluatePreflight({
      entries,
      applied,
      existingTables: ['users', 'sessions', 'profiles'],
      columnsByTable: {
        users: ['email'],
        sessions: allColumns.sessions,
        profiles: allColumns.profiles,
      },
    });
    expect(missingColumn).toContain(
      'public.users is missing column password_hash, which migration 01_init.sql requires.',
    );
  });

  it('rejects a changed migration, unknown ledger rows and non-contiguous history', async () => {
    const entries = await loadMigrations();

    const changed = evaluatePreflight({
      entries,
      applied: [{ name: '01_init.sql', checksum: '0'.repeat(64) }],
      existingTables: ['users', 'sessions', 'profiles'],
      columnsByTable: allColumns,
    });
    expect(changed.join(' ')).toMatch(/checksum does not match/);

    const unknown = evaluatePreflight({
      entries,
      applied: [{ name: '99_future.sql', checksum: '0'.repeat(64) }],
      existingTables: [],
      columnsByTable: {},
    });
    expect(unknown.join(' ')).toMatch(/unknown migration 99_future\.sql/);

    const gap = evaluatePreflight({
      entries,
      applied: [
        { name: '01_init.sql', checksum: entries[0]?.checksum ?? '' },
        {
          name: '03_create_monthly_budgets.sql',
          checksum: entries[2]?.checksum ?? '',
        },
      ],
      existingTables: [
        'users',
        'sessions',
        'profiles',
        'transactions',
        'monthly_budgets',
      ],
      columnsByTable: allColumns,
    });
    expect(gap.join(' ')).toMatch(/not a contiguous prefix/);
  });

  it('rejects the pre-04 category schema after migration 04 is recorded', async () => {
    const entries = await loadMigrations();
    const applied = entries.map((entry) => ({
      name: entry.name,
      checksum: entry.checksum,
    }));

    const errors = evaluatePreflight({
      entries,
      applied,
      existingTables: allTables,
      columnsByTable: {
        ...allColumns,
        monthly_budgets: [
          'user_id',
          'budget_month',
          'base_amount',
          'category',
        ],
      },
    });

    expect(errors.join(' ')).toMatch(
      /monthly_budgets still has a category column/,
    );
  });
});
