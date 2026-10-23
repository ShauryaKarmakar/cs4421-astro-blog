import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../src/lib/db', () => ({
  healthPool: { query },
}));

import { GET } from '../src/pages/api/health';

describe('database health endpoint', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('returns 200 only when the database answers a bounded SELECT 1', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const response = await GET({} as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns a generic 503 without database or credential details', async () => {
    query.mockRejectedValue(
      new Error('password authentication failed for user "unibudget_app"'),
    );

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain('unavailable');
    expect(body).not.toContain('password');
    expect(body).not.toContain('unibudget_app');
  });
});
