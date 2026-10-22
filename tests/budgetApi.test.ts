import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/session', () => ({
  getSessionCookie: vi.fn((request: Request) =>
    request.headers.get('cookie')?.match(/session=([^;]+)/)?.[1],
  ),
  validateSession: vi.fn(async (token: string) => token === 'valid-token' ? 'user-1' : null),
}));
vi.mock('../src/lib/db', () => ({ pool: { query: vi.fn() } }));

import { getBudgetUserId, parseBudgetInput } from '../src/lib/budgetApi';
import { GET } from '../src/pages/api/budgets/index';

describe('overall monthly budget API validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires positive monetary amounts with at most two decimal places', () => {
    for (const amount of ['0', '0.00', '-1', '1.001', '1e3', '1000000000000.00']) {
      expect(parseBudgetInput({ amount }).valid).toBe(false);
    }
    expect(parseBudgetInput({ amount: '0.01' })).toEqual({
      valid: true,
      value: { amount: '0.01' },
    });
    expect(parseBudgetInput({ amount: 500 }).valid).toBe(false);
  });

  it('rejects missing or unsupported fields including client-supplied ownership', () => {
    expect(parseBudgetInput({}).valid).toBe(false);
    expect(parseBudgetInput({ amount: '10', userId: 'other-user' }).valid).toBe(false);
    expect(parseBudgetInput({ amount: '10', month: '2025-01' }).valid).toBe(false);
  });

  it('resolves owner from the authenticated cookie rather than client input', async () => {
    expect(await getBudgetUserId(new Request('https://example.test/api/budgets'))).toBeNull();
    expect(
      await getBudgetUserId(
        new Request('https://example.test/api/budgets', {
          headers: { Cookie: 'session=valid-token' },
        }),
      ),
    ).toBe('user-1');
  });

  it('rejects unauthenticated API reads before querying budget data', async () => {
    const response = await GET({
      request: new Request('https://example.test/api/budgets'),
    } as Parameters<typeof GET>[0]);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized.' });
  });
});
