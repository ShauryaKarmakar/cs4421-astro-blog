import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  createMonthlyBudget,
  getMonthlyBudget,
  updateMonthlyBudgetAmount,
} from '../src/lib/budgetService';

const databaseUrl = process.env.BUDGET_TEST_DATABASE_URL;
const isCi = process.env.CI === 'true';
if (isCi && !databaseUrl) {
  throw new Error(
    'BUDGET_TEST_DATABASE_URL is required in CI; the PostgreSQL integration suite must not be skipped.',
  );
}
if (databaseUrl) {
  const parsedDatabaseUrl = new URL(databaseUrl);
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', 'postgres']);
  if (
    !['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol) ||
    parsedDatabaseUrl.pathname !== '/unibudget_test' ||
    !allowedHosts.has(parsedDatabaseUrl.hostname)
  ) {
    throw new Error(
      'BUDGET_TEST_DATABASE_URL must target the unibudget_test database on a local PostgreSQL host or the CI postgres service.',
    );
  }
}
const databaseDescribe = databaseUrl ? describe : describe.skip;

databaseDescribe('overall monthly budget PostgreSQL persistence and ownership', () => {
  let adminPool: Pool | undefined;
  let testPool: Pool | undefined;
  let schema = '';
  let ownerId = '';
  let otherUserId = '';
  const poolOptions = () => ({
    connectionString: databaseUrl!,
    max: 1,
    options: `-c search_path=${schema},public`,
  });

  beforeAll(async () => {
    if (!databaseUrl) return;

    schema = `budget_integration_${randomUUID().replace(/-/g, '')}`;
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    testPool = new Pool(poolOptions());

    for (const migration of [
      '../migrations/01_init.sql',
      '../migrations/02_create_transactions.sql',
      '../migrations/03_create_monthly_budgets.sql',
    ]) {
      await testPool.query(await readFile(new URL(migration, import.meta.url), 'utf8'));
    }

    ownerId = randomUUID();
    otherUserId = randomUUID();
    await testPool.query(
      `INSERT INTO users (id, email, password_hash)
       VALUES ($1, $2, 'integration-test'), ($3, $4, 'integration-test')`,
      [ownerId, `${ownerId}@example.test`, otherUserId, `${otherUserId}@example.test`],
    );

    await testPool.query(
      `INSERT INTO transactions
         (user_id, type, amount, category, description, transaction_date)
       VALUES
         ($1, 'expense', 240.00, 'Groceries', '', '2024-01-10'),
         ($1, 'expense', 20.00, 'Transit', '', '2024-01-31'),
         ($1, 'income', 7000.00, 'Income', '', '2024-01-31'),
         ($1, 'expense', 30.00, 'Groceries', '', '2024-02-01'),
         ($1, 'expense', 20.00, 'Books', '', '2024-02-15'),
         ($1, 'expense', 300.00, 'Groceries', '', '2024-02-16'),
         ($1, 'expense', 10.00, 'Food', '', '2024-03-01'),
         ($1, 'expense', 100.00, 'Food', '', '2024-03-31'),
         ($2, 'expense', 25.00, 'Groceries', '', '2024-01-10'),
         ($2, 'expense', 25.00, 'Groceries', '', '2024-02-10')`,
      [ownerId, otherUserId],
    );

    await testPool.query(
      `INSERT INTO monthly_budgets (user_id, category, budget_month, base_amount)
       VALUES
         ($1, 'Groceries', '2024-01-01', 300.00),
         ($1, 'Transit', '2024-01-01', 200.00),
         ($1, 'Groceries', '2024-02-01', 400.00),
         ($1, 'Books', '2024-02-01', 100.00),
         ($2, 'Groceries', '2024-02-01', 100.00)`,
      [ownerId, otherUserId],
    );
    await testPool.query(
      await readFile(new URL('../migrations/04_migrate_to_overall_monthly_budgets.sql', import.meta.url), 'utf8'),
    );
  });

  afterAll(async () => {
    await testPool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool?.end();
  });

  it('migrates old base totals, persists one monthly amount, and recalculates after restart', async () => {
    if (!testPool) throw new Error('Test database was not initialized.');

    const migrated = await getMonthlyBudget(testPool, ownerId, '2024-01', '2024-01-31');
    expect(migrated).toMatchObject({
      hasBudget: true,
      baseBudget: '500.00',
      openingRollover: '0.00',
      eligibleExpenses: '260.00',
      remainingBudget: '240.00',
    });

    const february = await getMonthlyBudget(testPool, ownerId, '2024-02', '2024-02-15');
    expect(february).toMatchObject({
      hasBudget: true,
      baseBudget: '500.00',
      openingRollover: '240.00',
      availableBudget: '740.00',
      eligibleExpenses: '50.00',
      remainingBudget: '690.00',
    });

    await expect(
      createMonthlyBudget(testPool, ownerId, '2024-02', { amount: '99.00' }),
    ).rejects.toMatchObject({ code: '23505' });

    const updated = await updateMonthlyBudgetAmount(testPool, ownerId, '2024-02', '400.00');
    expect(updated?.baseAmount).toBe('400.00');
    const editedFebruary = await getMonthlyBudget(testPool, ownerId, '2024-02', '2024-02-15');
    expect(editedFebruary).toMatchObject({
      baseBudget: '400.00',
      openingRollover: '240.00',
      availableBudget: '640.00',
      eligibleExpenses: '50.00',
      remainingBudget: '590.00',
    });
    expect(await getMonthlyBudget(testPool, ownerId, '2024-01', '2024-01-31'))
      .toEqual(migrated);

    const marchWithoutBase = await getMonthlyBudget(testPool, ownerId, '2024-03', '2024-03-15');
    expect(marchWithoutBase).toMatchObject({
      hasBudget: false,
      baseBudget: '0.00',
      openingRollover: '290.00',
      availableBudget: '290.00',
      eligibleExpenses: '10.00',
      remainingBudget: '280.00',
    });

    await testPool.end();
    testPool = new Pool(poolOptions());
    const afterRestart = await getMonthlyBudget(testPool, ownerId, '2024-02', '2024-02-15');
    expect(afterRestart).toEqual(editedFebruary);
    expect(await getMonthlyBudget(testPool, ownerId, '2024-02', '2024-02-15'))
      .toEqual(afterRestart);
  });

  it('scopes base budgets and updates to the authenticated user id', async () => {
    if (!testPool) throw new Error('Test database was not initialized.');

    expect(
      await updateMonthlyBudgetAmount(testPool, otherUserId, '2024-01', '999.00'),
    ).toBeNull();
    expect(
      await getMonthlyBudget(testPool, otherUserId, '2024-01', '2024-01-31'),
    ).toMatchObject({
      hasBudget: false,
      baseBudget: '0.00',
      eligibleExpenses: '25.00',
    });

    const created = await createMonthlyBudget(testPool, otherUserId, '2024-01', {
      amount: '100.00',
    });
    expect(created.baseAmount).toBe('100.00');
    expect(await updateMonthlyBudgetAmount(testPool, ownerId, '2024-01', '500.00'))
      .not.toBeNull();
    expect(
      await getMonthlyBudget(testPool, otherUserId, '2024-01', '2024-01-31'),
    ).toMatchObject({
      baseBudget: '100.00',
      eligibleExpenses: '25.00',
    });
  });
});
