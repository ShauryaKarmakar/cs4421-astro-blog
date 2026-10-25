import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, assertApplicationRole } = vi.hoisted(() => ({
  query: vi.fn(),
  assertApplicationRole: vi.fn(),
}));

vi.mock('astro:middleware', () => ({
  defineMiddleware: (handler: unknown) => handler,
}));

vi.mock('../src/lib/db', () => ({
  healthPool: { query },
  assertApplicationRole,
}));

vi.mock('../src/lib/session', () => ({
  getSessionCookie: vi.fn(),
  validateSession: vi.fn(),
}));

import { GET } from '../src/pages/api/live';
import { onRequest } from '../src/middleware/auth';

describe('process liveness endpoint', () => {
  beforeEach(() => {
    query.mockReset();
    assertApplicationRole.mockReset();
  });

  it('answers 200 from the process without touching the database', async () => {
    const response = await GET({} as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(query).not.toHaveBeenCalled();
    expect(assertApplicationRole).not.toHaveBeenCalled();
  });

  it('stays 200 while the database is failing', async () => {
    query.mockRejectedValue(
      new Error('password authentication failed for user "unibudget_app"'),
    );
    assertApplicationRole.mockRejectedValue(new Error('role mismatch'));

    const response = await GET({} as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('does not disclose database, role, or credential details', async () => {
    const body = await (await GET({} as never)).text();

    expect(body).toBe('{"status":"ok"}');
    expect(body).not.toContain('unibudget');
    expect(body).not.toContain('postgres');
    expect(body).not.toContain('password');
  });
});

describe('middleware liveness bypass', () => {
  function context(path: string) {
    return {
      request: new Request(`https://d111111abcdef8.cloudfront.net${path}`),
      locals: {},
      redirect: vi.fn(),
    } as never;
  }

  beforeEach(() => {
    assertApplicationRole.mockReset();
    assertApplicationRole.mockResolvedValue(undefined);
  });

  it.each(['/api/live', '/api/health'])(
    'lets %s through without running the database role gate',
    async (path) => {
      const next = vi.fn().mockResolvedValue(new Response('ok'));

      const response = await onRequest(context(path), next as never);

      expect(assertApplicationRole).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
    },
  );

  it('still applies the role gate to an ordinary route', async () => {
    assertApplicationRole.mockRejectedValue(
      new Error('The application connected as postgres instead of unibudget_app.'),
    );
    const next = vi.fn().mockResolvedValue(new Response('ok'));

    const response = await onRequest(context('/'), next as never);

    expect(assertApplicationRole).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
  });
});
