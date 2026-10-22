import type { APIRoute } from 'astro';
import { pool } from '../../../lib/db';
import {
  formatTransaction,
  getTransactionUserId,
  jsonResponse,
  parseTransactionInput,
  type TransactionInput,
  type TransactionRow,
} from '../../../lib/transactionApi';
import { logServerError } from '../../../lib/serverLogger';

const transactionColumns = `
  id,
  type,
  amount::text AS amount,
  category,
  description,
  transaction_date::text AS "transactionDate",
  store_name AS "storeName",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export const GET: APIRoute = async ({ request }) => {
  try {
    const userId = await getTransactionUserId(request);
    if (!userId) return jsonResponse({ error: 'Unauthorized.' }, 401);

    const result = await pool.query<TransactionRow>(
      `SELECT ${transactionColumns}
       FROM transactions
       WHERE user_id = $1
       ORDER BY transaction_date DESC, created_at DESC, id DESC`,
      [userId],
    );

    return jsonResponse({ transactions: result.rows.map(formatTransaction) });
  } catch (error) {
    logServerError('transactions.list.failed', error);
    return jsonResponse({ error: 'Unable to retrieve transactions.' }, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const userId = await getTransactionUserId(request);
    if (!userId) return jsonResponse({ error: 'Unauthorized.' }, 401);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Request body must contain valid JSON.' }, 400);
    }

    const validation = parseTransactionInput(body);
    if (!validation.valid) return jsonResponse({ error: validation.error }, 400);
    const transaction = validation.value as TransactionInput;

    const result = await pool.query<TransactionRow>(
      `INSERT INTO transactions
         (user_id, type, amount, category, description, transaction_date, store_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${transactionColumns}`,
      [
        userId,
        transaction.type,
        transaction.amount,
        transaction.category,
        transaction.description ?? '',
        transaction.transactionDate,
        transaction.storeName ?? null,
      ],
    );

    return jsonResponse({ transaction: formatTransaction(result.rows[0]) }, 201);
  } catch (error) {
    logServerError('transactions.create.failed', error);
    return jsonResponse({ error: 'Unable to create transaction.' }, 500);
  }
};
