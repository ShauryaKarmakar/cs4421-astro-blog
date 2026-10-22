import type { APIRoute } from 'astro';
import { isValidTimeZone, getCalendarDateInTimeZone } from '../../../lib/financialCalculations';
import { pool } from '../../../lib/db';
import {
  getBudgetUserId,
  jsonBudgetResponse,
  parseBudgetInput,
  type BudgetInput,
} from '../../../lib/budgetApi';
import { isValidBudgetMonth } from '../../../lib/budgetCalculations';
import { createMonthlyBudget, getMonthlyBudget, updateMonthlyBudgetAmount } from '../../../lib/budgetService';
import { logServerError } from '../../../lib/serverLogger';

async function getToday(userId: string): Promise<string> {
  const result = await pool.query<{ timezone: string | null }>(
    `SELECT timezone
     FROM profiles
     WHERE user_id = $1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId],
  );
  const timeZone = result.rows[0]?.timezone ?? 'UTC';
  if (!isValidTimeZone(timeZone)) throw new Error('User profile contains an invalid timezone.');
  return getCalendarDateInTimeZone(new Date(), timeZone);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

type ParsedBudgetInput =
  | { valid: true; value: BudgetInput }
  | { valid: false; response: Response };

async function readBudgetInput(request: Request): Promise<ParsedBudgetInput> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      valid: false,
      response: jsonBudgetResponse({ error: 'Request body must contain valid JSON.' }, 400),
    };
  }

  const validation = parseBudgetInput(body);
  if (!validation.valid) {
    return { valid: false, response: jsonBudgetResponse({ error: validation.error }, 400) };
  }
  return { valid: true, value: validation.value };
}

export const GET: APIRoute = async ({ request }) => {
  try {
    const userId = await getBudgetUserId(request);
    if (!userId) return jsonBudgetResponse({ error: 'Unauthorized.' }, 401);

    const today = await getToday(userId);
    const currentMonth = today.slice(0, 7);
    const requestedMonth = new URL(request.url).searchParams.get('month');
    if (requestedMonth !== null && !isValidBudgetMonth(requestedMonth)) {
      return jsonBudgetResponse({ error: 'Month must be a valid YYYY-MM month.' }, 400);
    }
    const month = requestedMonth ?? currentMonth;
    if (month > currentMonth) {
      return jsonBudgetResponse({ error: 'Future budget months are not available.' }, 400);
    }

    const budget = await getMonthlyBudget(pool, userId, month, today);
    return jsonBudgetResponse({ budget, month, today });
  } catch (error) {
    logServerError('budgets.get.failed', error);
    return jsonBudgetResponse({ error: 'Unable to retrieve the monthly budget.' }, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const userId = await getBudgetUserId(request);
    if (!userId) return jsonBudgetResponse({ error: 'Unauthorized.' }, 401);
    const parsed = await readBudgetInput(request);
    if (!parsed.valid) return parsed.response;

    const today = await getToday(userId);
    const month = today.slice(0, 7);
    try {
      const budget = await createMonthlyBudget(pool, userId, month, parsed.value);
      return jsonBudgetResponse({ budget }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return jsonBudgetResponse({ error: 'A budget already exists for this month.' }, 409);
      }
      throw error;
    }
  } catch (error) {
    logServerError('budgets.create.failed', error);
    return jsonBudgetResponse({ error: 'Unable to create the monthly budget.' }, 500);
  }
};

export const PATCH: APIRoute = async ({ request }) => {
  try {
    const userId = await getBudgetUserId(request);
    if (!userId) return jsonBudgetResponse({ error: 'Unauthorized.' }, 401);
    const parsed = await readBudgetInput(request);
    if (!parsed.valid) return parsed.response;

    const today = await getToday(userId);
    const month = today.slice(0, 7);
    const budget = await updateMonthlyBudgetAmount(pool, userId, month, parsed.value.amount);
    if (!budget) return jsonBudgetResponse({ error: 'No budget exists for this month yet.' }, 404);
    return jsonBudgetResponse({ budget });
  } catch (error) {
    logServerError('budgets.update.failed', error);
    return jsonBudgetResponse({ error: 'Unable to update the monthly budget.' }, 500);
  }
};
