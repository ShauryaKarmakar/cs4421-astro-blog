import type { Pool } from 'pg';
import {
  calculateMonthlyBudget,
  type MonthlyBudgetRecord,
  type MonthlyExpenseRecord,
  type MonthlyBudgetResult,
} from './budgetCalculations';
import type { BudgetInput } from './budgetApi';

type BudgetDatabase = Pick<Pool, 'query'>;

interface BudgetDbRow {
  id: string;
  month: string;
  baseAmount: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface ExpenseDbRow {
  month: string;
  amount: string;
}

export interface BudgetView extends MonthlyBudgetResult {
  id: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}

const budgetColumns = `
  id,
  to_char(budget_month, 'YYYY-MM') AS month,
  base_amount::text AS "baseAmount",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function monthEnd(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return `${month}-${String(days[monthNumber - 1]).padStart(2, '0')}`;
}

export async function getMonthlyBudget(
  database: BudgetDatabase,
  userId: string,
  month: string,
  today: string,
): Promise<BudgetView> {
  const [budgetResult, historyResult] = await Promise.all([
    database.query<BudgetDbRow>(
      `SELECT ${budgetColumns}
       FROM monthly_budgets
       WHERE user_id = $1 AND budget_month = $2::date`,
      [userId, `${month}-01`],
    ),
    database.query<BudgetDbRow>(
      `SELECT ${budgetColumns}
       FROM monthly_budgets
       WHERE user_id = $1 AND budget_month < $2::date
       ORDER BY budget_month`,
      [userId, `${month}-01`],
    ),
  ]);

  const budget = budgetResult.rows[0] ?? null;
  const historyRows = [...historyResult.rows, ...(budget ? [budget] : [])];
  const history: MonthlyBudgetRecord[] = historyRows.map(({ month: budgetMonth, baseAmount }) => ({
    month: budgetMonth,
    baseAmount,
  }));
  const earliestMonth = history[0]?.month ?? month;
  const endDate = monthEnd(month);
  const throughDate = endDate < today ? endDate : today;

  let expenses: MonthlyExpenseRecord[] = [];
  if (earliestMonth <= throughDate.slice(0, 7)) {
    const expenseResult = await database.query<ExpenseDbRow>(
      `SELECT to_char(date_trunc('month', transaction_date)::date, 'YYYY-MM') AS month,
              SUM(amount)::text AS amount
       FROM transactions
       WHERE user_id = $1
         AND type = 'expense'
         AND transaction_date >= $2::date
         AND transaction_date <= $3::date
       GROUP BY date_trunc('month', transaction_date)
       ORDER BY date_trunc('month', transaction_date)`,
      [userId, `${earliestMonth}-01`, throughDate],
    );
    expenses = expenseResult.rows;
  }

  const calculation = calculateMonthlyBudget(history, expenses, month);
  return {
    ...calculation,
    id: budget?.id ?? null,
    createdAt: budget?.createdAt ?? null,
    updatedAt: budget?.updatedAt ?? null,
  };
}

export async function createMonthlyBudget(
  database: BudgetDatabase,
  userId: string,
  month: string,
  input: BudgetInput,
): Promise<BudgetDbRow> {
  const result = await database.query<BudgetDbRow>(
    `INSERT INTO monthly_budgets (user_id, budget_month, base_amount)
     VALUES ($1, $2::date, $3)
     RETURNING ${budgetColumns}`,
    [userId, `${month}-01`, input.amount],
  );
  return result.rows[0];
}

export async function updateMonthlyBudgetAmount(
  database: BudgetDatabase,
  userId: string,
  month: string,
  amount: string,
): Promise<BudgetDbRow | null> {
  const result = await database.query<BudgetDbRow>(
    `UPDATE monthly_budgets
     SET base_amount = $1, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $2 AND budget_month = $3::date
     RETURNING ${budgetColumns}`,
    [amount, userId, `${month}-01`],
  );
  return result.rows[0] ?? null;
}
