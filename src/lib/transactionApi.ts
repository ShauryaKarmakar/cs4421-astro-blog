import { getSessionCookie, validateSession } from './session';

export interface TransactionRow {
  id: string;
  type: 'income' | 'expense';
  amount: string;
  category: string;
  description: string;
  transactionDate: string;
  storeName: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface TransactionInput {
  type: 'income' | 'expense';
  amount: string;
  category: string;
  description?: string;
  transactionDate: string;
  storeName?: string;
}

export type TransactionPatch = Omit<Partial<TransactionInput>, 'storeName'> & {
  storeName?: string | null;
};

type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; error: string };

const transactionFields = new Set([
  'type',
  'amount',
  'category',
  'description',
  'transactionDate',
  'storeName',
]);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const amountPattern = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export async function getTransactionUserId(request: Request): Promise<string | null> {
  const token = getSessionCookie(request);
  return token ? validateSession(token) : null;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function isValidTransactionId(id: string | undefined): id is string {
  return typeof id === 'string' && uuidPattern.test(id);
}

export function parseTransactionInput(
  input: unknown,
  partial = false,
): ValidationResult<TransactionInput | TransactionPatch> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const body = input as Record<string, unknown>;
  const fields = Object.keys(body);

  if (fields.some((field) => !transactionFields.has(field))) {
    return { valid: false, error: 'Request contains an unsupported field.' };
  }

  if (fields.length === 0) {
    return { valid: false, error: 'Request body must include at least one field.' };
  }

  const requiredFields = ['type', 'amount', 'category', 'transactionDate'];
  if (!partial && requiredFields.some((field) => !Object.hasOwn(body, field))) {
    return { valid: false, error: 'Required transaction fields are missing.' };
  }

  const value: TransactionPatch = {};

  if (Object.hasOwn(body, 'type')) {
    if (body.type !== 'income' && body.type !== 'expense') {
      return { valid: false, error: 'Type must be income or expense.' };
    }
    value.type = body.type;
  }

  if (Object.hasOwn(body, 'amount')) {
    const rawAmount = body.amount;
    if (typeof rawAmount !== 'string' && typeof rawAmount !== 'number') {
      return { valid: false, error: 'Amount must be a positive number with up to two decimal places.' };
    }

    const amount = String(rawAmount);
    if (!amountPattern.test(amount) || Number(amount) <= 0) {
      return { valid: false, error: 'Amount must be a positive number with up to two decimal places.' };
    }
    value.amount = amount;
  }

  if (Object.hasOwn(body, 'category')) {
    if (typeof body.category !== 'string') {
      return { valid: false, error: 'Category must be a non-empty string of at most 100 characters.' };
    }
    const category = body.category.trim();
    if (!category || category.length > 100) {
      return { valid: false, error: 'Category must be a non-empty string of at most 100 characters.' };
    }
    value.category = category;
  }

  if (Object.hasOwn(body, 'description')) {
    if (typeof body.description !== 'string') {
      return { valid: false, error: 'Description must be a string of at most 1000 characters.' };
    }
    const description = body.description.trim();
    if (description.length > 1000) {
      return { valid: false, error: 'Description must be a string of at most 1000 characters.' };
    }
    value.description = description;
  } else if (!partial) {
    value.description = '';
  }

  if (Object.hasOwn(body, 'transactionDate')) {
    if (typeof body.transactionDate !== 'string' || !isValidDate(body.transactionDate)) {
      return { valid: false, error: 'Transaction date must be a valid YYYY-MM-DD date.' };
    }
    value.transactionDate = body.transactionDate;
  }

  if (Object.hasOwn(body, 'storeName')) {
    if (body.storeName === null && partial) {
      value.storeName = null;
    } else if (typeof body.storeName === 'string') {
      const storeName = body.storeName.trim();
      if (!storeName || storeName.length > 200) {
        return { valid: false, error: 'Store name must be a non-empty string of at most 200 characters.' };
      }
      value.storeName = storeName;
    } else {
      return { valid: false, error: 'Store name must be a string.' };
    }
  }

  return { valid: true, value };
}

function isValidDate(value: string): boolean {
  const match = datePattern.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return day >= 1 && day <= daysInMonth[month - 1];
}

export function formatTransaction(row: TransactionRow) {
  return {
    id: row.id,
    type: row.type,
    amount: row.amount,
    category: row.category,
    description: row.description,
    transactionDate: row.transactionDate,
    storeName: row.storeName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
