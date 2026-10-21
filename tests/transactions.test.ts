import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/lib/db';
import { getSessionCookie, validateSession } from '../src/lib/session';
import { GET as getTransactions, POST as createTransaction } from '../src/pages/api/transactions/index';
import {
  DELETE as deleteTransaction,
  GET as getTransaction,
  PATCH as updateTransaction,
} from '../src/pages/api/transactions/[id]';

vi.mock('../src/lib/db', () => ({
  pool: {
    query: vi.fn(),
  },
}));

vi.mock('../src/lib/session', () => ({
  getSessionCookie: vi.fn(),
  validateSession: vi.fn(),
}));

const userId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const otherUserId = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const transactionId = '11111111-2222-4333-8444-555555555555';

const transactionRow = {
  id: transactionId,
  type: 'expense' as const,
  amount: '12.50',
  category: 'Food',
  description: 'Lunch',
  transactionDate: '2026-10-14',
  storeName: 'Cafe',
  createdAt: new Date('2026-10-14T12:00:00Z'),
  updatedAt: new Date('2026-10-14T12:00:00Z'),
};

const serializedTransaction = {
  ...transactionRow,
  createdAt: transactionRow.createdAt.toISOString(),
  updatedAt: transactionRow.updatedAt.toISOString(),
};

function makeContext(
  handler: (...args: never[]) => unknown,
  request: Request,
  id?: string,
) {
  return {
    request,
    params: id === undefined ? {} : { id },
  } as Parameters<typeof handler>[0];
}

function makeRequest(method: string, body?: unknown): Request {
  return new Request('http://localhost/api/transactions', {
    method,
    headers: { cookie: 'session=valid-session' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionCookie).mockReturnValue('valid-session');
  vi.mocked(validateSession).mockResolvedValue(userId);
});

describe('transaction collection API', () => {
  it('requires an authenticated session before querying transactions', async () => {
    vi.mocked(getSessionCookie).mockReturnValue(undefined);

    const response = await getTransactions(makeContext(getTransactions, makeRequest('GET')));

    expect(response.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
    expect(validateSession).not.toHaveBeenCalled();
  });

  it('lists only the authenticated user’s transactions in stable date order', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [transactionRow], rowCount: 1 });

    const response = await getTransactions(makeContext(getTransactions, makeRequest('GET')));
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body.transactions).toEqual([serializedTransaction]);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE user_id = \$1[\s\S]*ORDER BY transaction_date DESC, created_at DESC, id DESC/),
      [userId],
    );
  });

  it('creates a transaction for the session user and returns the stored row', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [transactionRow], rowCount: 1 });
    const payload = {
      type: 'expense',
      amount: '12.50',
      category: '  Food  ',
      description: ' Lunch ',
      transactionDate: '2026-10-14',
      storeName: ' Cafe ',
    };

    const response = await createTransaction(
      makeContext(createTransaction, makeRequest('POST', payload)),
    );

    expect(response.status).toBe(201);
    expect(await responseJson(response)).toEqual({ transaction: serializedTransaction });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO transactions[\s\S]*VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7\)/),
      [userId, 'expense', '12.50', 'Food', 'Lunch', '2026-10-14', 'Cafe'],
    );
  });

  it.each([
    [{ ...validCreateBody, description: undefined }, 'omitted description'],
    [{ ...validCreateBody, description: '   ' }, 'blank description'],
  ])('creates a transaction with an optional %s', async (body) => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [transactionRow], rowCount: 1 });
    const payload = {
      type: body.type,
      amount: body.amount,
      category: body.category,
      transactionDate: body.transactionDate,
    };

    const response = await createTransaction(
      makeContext(createTransaction, makeRequest('POST', payload)),
    );

    expect(response.status).toBe(201);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO transactions'),
      [userId, 'income', '1250', 'Salary', '', '2024-02-29', null],
    );
  });

  it('rejects malformed JSON without accessing the database', async () => {
    const request = new Request('http://localhost/api/transactions', {
      method: 'POST',
      headers: { cookie: 'session=valid-session' },
      body: '{bad json',
    });

    const response = await createTransaction(makeContext(createTransaction, request));

    expect(response.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...validCreateBody, type: 'transfer' }, 'unsupported type'],
    [{ ...validCreateBody, amount: 0 }, 'zero amount'],
    [{ ...validCreateBody, amount: -4 }, 'negative amount'],
    [{ ...validCreateBody, amount: '1.001' }, 'excess amount precision'],
    [{ ...validCreateBody, amount: '10000000000.00' }, 'amount exceeding numeric precision'],
    [{ ...validCreateBody, category: '   ' }, 'empty category'],
    [{ ...validCreateBody, transactionDate: '2026-02-29' }, 'impossible date'],
    [{ ...validCreateBody, transactionDate: '2026-1-02' }, 'malformed date'],
    [{ ...validCreateBody, unexpected: 'value' }, 'unexpected field'],
    [{ ...validCreateBody, userId: otherUserId }, 'client-supplied user ID'],
    [{ ...validCreateBody, storeName: 42 }, 'invalid store name type'],
    [{ ...validCreateBody, category: 'x'.repeat(101) }, 'category too long'],
  ])('rejects invalid create input (%s)', async (body) => {
    const response = await createTransaction(
      makeContext(createTransaction, makeRequest('POST', body)),
    );

    expect(response.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a valid transaction if no authenticated user can be resolved', async () => {
    vi.mocked(validateSession).mockResolvedValue(null);

    const response = await createTransaction(
      makeContext(createTransaction, makeRequest('POST', validCreateBody)),
    );

    expect(response.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('transaction item API', () => {
  it('rejects malformed IDs before issuing a query', async () => {
    const response = await getTransaction(
      makeContext(getTransaction, makeRequest('GET'), 'not-a-uuid'),
    );

    expect(response.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('gets a transaction only when both its ID and owner match', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [transactionRow], rowCount: 1 });

    const response = await getTransaction(
      makeContext(getTransaction, makeRequest('GET'), transactionId),
    );

    expect(response.status).toBe(200);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE id = \$1 AND user_id = \$2/),
      [transactionId, userId],
    );
  });

  it('returns not found for another user’s transaction', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await getTransaction(
      makeContext(getTransaction, makeRequest('GET'), transactionId),
    );

    expect(response.status).toBe(404);
    expect(await responseJson(response)).toEqual({ error: 'Transaction not found.' });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE id = \$1 AND user_id = \$2/),
      [transactionId, userId],
    );
  });

  it('patches only provided allowed fields and scopes the update by owner', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [transactionRow], rowCount: 1 });

    const response = await updateTransaction(
      makeContext(
        updateTransaction,
        makeRequest('PATCH', { description: 'Updated lunch', storeName: null }),
        transactionId,
      ),
    );

    expect(response.status).toBe(200);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/SET description = \$1, store_name = \$2, updated_at = CURRENT_TIMESTAMP[\s\S]*WHERE id = \$3 AND user_id = \$4/),
      ['Updated lunch', null, transactionId, userId],
    );
  });

  it('allows clearing an existing description', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [transactionRow], rowCount: 1 });

    const response = await updateTransaction(
      makeContext(updateTransaction, makeRequest('PATCH', { description: '   ' }), transactionId),
    );

    expect(response.status).toBe(200);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/SET description = \$1[\s\S]*WHERE id = \$2 AND user_id = \$3/),
      ['', transactionId, userId],
    );
  });

  it.each([
    [{}, 'empty patch'],
    [{ userId: otherUserId }, 'attempted ownership patch'],
    [{ amount: '0' }, 'zero patch amount'],
    [{ transactionDate: '2026-13-01' }, 'invalid patch date'],
    [{ description: 'x'.repeat(1001) }, 'oversized patch description'],
  ])('rejects invalid patch input (%s)', async (body) => {
    const response = await updateTransaction(
      makeContext(updateTransaction, makeRequest('PATCH', body), transactionId),
    );

    expect(response.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('deletes only the authenticated user’s matching transaction', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ id: transactionId }], rowCount: 1 });

    const response = await deleteTransaction(
      makeContext(deleteTransaction, makeRequest('DELETE'), transactionId),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({ message: 'Transaction deleted.' });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM transactions[\s\S]*WHERE id = \$1 AND user_id = \$2/),
      [transactionId, userId],
    );
  });

  it('returns not found rather than deleting another user’s transaction', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await deleteTransaction(
      makeContext(deleteTransaction, makeRequest('DELETE'), transactionId),
    );

    expect(response.status).toBe(404);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE id = \$1 AND user_id = \$2/),
      [transactionId, userId],
    );
  });

  it('requires authentication on item routes', async () => {
    vi.mocked(validateSession).mockResolvedValue(null);

    const response = await updateTransaction(
      makeContext(
        updateTransaction,
        makeRequest('PATCH', { description: 'Changed' }),
        transactionId,
      ),
    );

    expect(response.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

const validCreateBody = {
  type: 'income',
  amount: 1250,
  category: 'Salary',
  description: 'Monthly pay',
  transactionDate: '2024-02-29',
};
