import type { APIRoute } from 'astro';
import { pool } from '../../../lib/db';
import {
  formatTransaction,
  getTransactionUserId,
  isValidTransactionId,
  jsonResponse,
  parseTransactionInput,
  type TransactionPatch,
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

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const userId = await getTransactionUserId(request);
    if (!userId) return jsonResponse({ error: 'Unauthorized.' }, 401);
    const id = params.id;
    if (!isValidTransactionId(id)) return jsonResponse({ error: 'Invalid transaction ID.' }, 400);

    const result = await pool.query<TransactionRow>(
      `SELECT ${transactionColumns}
       FROM transactions
       WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );

    if (result.rows.length === 0) return jsonResponse({ error: 'Transaction not found.' }, 404);
    return jsonResponse({ transaction: formatTransaction(result.rows[0]) });
  } catch (error) {
    logServerError('transactions.get.failed', error);
    return jsonResponse({ error: 'Unable to retrieve transaction.' }, 500);
  }
};

export const PATCH: APIRoute = async ({ request, params }) => {
  try {
    const userId = await getTransactionUserId(request);
    if (!userId) return jsonResponse({ error: 'Unauthorized.' }, 401);
    const id = params.id;
    if (!isValidTransactionId(id)) return jsonResponse({ error: 'Invalid transaction ID.' }, 400);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Request body must contain valid JSON.' }, 400);
    }

    const validation = parseTransactionInput(body, true);
    if (!validation.valid) return jsonResponse({ error: validation.error }, 400);
    const transaction = validation.value as TransactionPatch;

    const columns: Record<keyof TransactionPatch, string> = {
      type: 'type',
      amount: 'amount',
      category: 'category',
      description: 'description',
      transactionDate: 'transaction_date',
      storeName: 'store_name',
    };
    const values: unknown[] = [];
    const assignments = Object.entries(transaction).map(([key, value]) => {
      values.push(value);
      return `${columns[key as keyof TransactionPatch]} = $${values.length}`;
    });
    values.push(id, userId);

    const result = await pool.query<TransactionRow>(
      `UPDATE transactions
       SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${values.length - 1} AND user_id = $${values.length}
       RETURNING ${transactionColumns}`,
      values,
    );

    if (result.rows.length === 0) return jsonResponse({ error: 'Transaction not found.' }, 404);
    return jsonResponse({ transaction: formatTransaction(result.rows[0]) });
  } catch (error) {
    logServerError('transactions.update.failed', error);
    return jsonResponse({ error: 'Unable to update transaction.' }, 500);
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const userId = await getTransactionUserId(request);
    if (!userId) return jsonResponse({ error: 'Unauthorized.' }, 401);
    const id = params.id;
    if (!isValidTransactionId(id)) return jsonResponse({ error: 'Invalid transaction ID.' }, 400);

    const result = await pool.query(
      `DELETE FROM transactions
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, userId],
    );

    if (result.rows.length === 0) return jsonResponse({ error: 'Transaction not found.' }, 404);
    return jsonResponse({ message: 'Transaction deleted.' });
  } catch (error) {
    logServerError('transactions.delete.failed', error);
    return jsonResponse({ error: 'Unable to delete transaction.' }, 500);
  }
};
