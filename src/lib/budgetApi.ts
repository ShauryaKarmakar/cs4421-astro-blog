import { getSessionCookie, validateSession } from './session';
import { parseBudgetAmount } from './budgetCalculations';

export interface BudgetInput {
  amount: string;
}

type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; error: string };

export async function getBudgetUserId(request: Request): Promise<string | null> {
  const token = getSessionCookie(request);
  return token ? validateSession(token) : null;
}

export function jsonBudgetResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export function parseBudgetInput(input: unknown): ValidationResult<BudgetInput> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const body = input as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'amount')) {
    return { valid: false, error: 'Only the monthly budget amount can be set.' };
  }

  const amount = parseBudgetAmount(body.amount);
  if (!amount) {
    return { valid: false, error: 'Amount must be positive and have at most two decimal places.' };
  }

  return { valid: true, value: { amount } };
}

export const parseBudgetPatch = parseBudgetInput;
