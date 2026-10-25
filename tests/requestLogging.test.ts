import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { assertApplicationRole, getSessionCookie, validateSession } = vi.hoisted(
  () => ({
    assertApplicationRole: vi.fn(),
    getSessionCookie: vi.fn(),
    validateSession: vi.fn(),
  }),
);

vi.mock('astro:middleware', () => ({
  defineMiddleware: (handler: unknown) => handler,
}));

vi.mock('../src/lib/db', () => ({
  assertApplicationRole,
}));

vi.mock('../src/lib/session', () => ({
  getSessionCookie,
  validateSession,
}));

import { onRequest } from '../src/middleware/auth';
import { logServerError } from '../src/lib/serverLogger';

interface LogRecord {
  level: string;
  timestamp: string;
  event: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  errorName?: string;
}

let stdout: string[] = [];
let stderr: string[] = [];

function parseRecords(chunks: string[]): LogRecord[] {
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogRecord);
}

function context(
  path: string,
  init: { method?: string; headers?: Record<string, string>; redirect?: boolean } = {},
) {
  return {
    request: new Request(`https://d111111abcdef8.cloudfront.net${path}`, {
      method: init.method ?? 'GET',
      headers: init.headers,
    }),
    locals: {} as Record<string, unknown>,
    redirect: vi.fn(
      (location: string) => new Response(null, { status: 302, headers: { Location: location } }),
    ),
  } as never;
}

function nextReturning(status = 200, body = 'ok') {
  return vi.fn(async () => new Response(body, { status })) as never;
}

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as never);
  assertApplicationRole.mockReset();
  assertApplicationRole.mockResolvedValue(undefined);
  getSessionCookie.mockReset();
  getSessionCookie.mockReturnValue(undefined);
  validateSession.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('structured request logging', () => {
  it('writes one JSON access record with route, method, status, latency and timestamp', async () => {
    const response = await onRequest(
      context('/blog/first-post'),
      nextReturning(200),
    );

    const records = parseRecords(stdout);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.level).toBe('info');
    expect(record.event).toBe('http.request');
    expect(record.method).toBe('GET');
    expect(record.path).toBe('/blog/first-post');
    expect(record.status).toBe(200);
    expect(typeof record.durationMs).toBe('number');
    expect(Number.isFinite(record.durationMs)).toBe(true);
    expect(record.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toBe(record.requestId);
    expect(stderr.join('')).toBe('');
  });

  it('keeps the health probes as separate, searchable records', async () => {
    await onRequest(context('/api/live'), nextReturning(200));
    await onRequest(context('/api/health'), nextReturning(503));

    const records = parseRecords(stdout);
    expect(records.map((record) => [record.path, record.status, record.level])).toEqual([
      ['/api/live', 200, 'info'],
      ['/api/health', 503, 'warn'],
    ]);
  });

  it('reuses a valid caller request id and replaces an unsafe one', async () => {
    const first = await onRequest(
      context('/login', { headers: { 'x-request-id': 'edcb1f5a-from-lb.1' } }),
      nextReturning(200),
    );
    const second = await onRequest(
      context('/login', { headers: { 'x-request-id': 'not valid with spaces' } }),
      nextReturning(200),
    );
    const third = await onRequest(
      context('/login', { headers: { 'x-request-id': 'a'.repeat(200) } }),
      nextReturning(200),
    );

    const records = parseRecords(stdout);
    expect(records[0].requestId).toBe('edcb1f5a-from-lb.1');
    expect(first.headers.get('X-Request-Id')).toBe('edcb1f5a-from-lb.1');
    expect(records[1].requestId).not.toContain('not valid');
    expect(records[1].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.headers.get('X-Request-Id')).toBe(records[1].requestId);
    expect(records[2].requestId).not.toBe('a'.repeat(200));
    expect(records[2].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(third.headers.get('X-Request-Id')).toBe(records[2].requestId);
    expect(stderr.join('')).toBe('');
  });

  it('gives concurrent requests distinct request ids', async () => {
    await Promise.all([
      onRequest(context('/blog/first-post'), nextReturning(200)),
      onRequest(context('/blog/second-post'), nextReturning(200)),
    ]);

    const ids = parseRecords(stdout).map((record) => record.requestId);
    expect(new Set(ids).size).toBe(2);
  });

  it('correlates a server error with the access record for the same request', async () => {
    assertApplicationRole.mockRejectedValue(
      new Error('password authentication failed for user "unibudget_app"'),
    );

    const response = await onRequest(context('/dashboard'), nextReturning(200));

    const access = parseRecords(stdout);
    const errors = parseRecords(stderr);
    expect(response.status).toBe(503);
    expect(access).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(access[0].status).toBe(503);
    expect(access[0].level).toBe('warn');
    expect(errors[0].event).toBe('middleware.database_role.failed');
    expect(errors[0].errorName).toBe('Error');
    expect(errors[0].requestId).toBe(access[0].requestId);
    expect(errors[0].method).toBe('GET');
    expect(errors[0].path).toBe('/dashboard');
    expect(errors[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('logs a redirect with a correlation id even though redirect headers are immutable', async () => {
    const response = await onRequest(context('/dashboard'), nextReturning(200));

    const [record] = parseRecords(stdout);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/login');
    expect(response.headers.get('X-Request-Id')).toBe(record.requestId);
    expect(record.status).toBe(302);
    // A redirect is a normal outcome, not a failure; only 4xx and 5xx are warn.
    expect(record.level).toBe('info');
  });

  it('does not treat expected 401, 403 or 404 responses as server crashes', async () => {
    await onRequest(context('/api/auth/me'), nextReturning(401));
    await onRequest(context('/api/transactions'), nextReturning(403));
    await onRequest(context('/blog/not-a-real-post'), nextReturning(404));

    const access = parseRecords(stdout);
    expect(access.map((record) => [record.path, record.status, record.level])).toEqual([
      ['/api/auth/me', 401, 'warn'],
      ['/api/transactions', 403, 'warn'],
      ['/blog/not-a-real-post', 404, 'warn'],
    ]);
    // No exception record, so StructuredErrorCount is not incremented.
    expect(parseRecords(stderr)).toEqual([]);
    for (const record of access) {
      expect(record.level).not.toBe('error');
    }
  });

  it('never logs the query string, cookies, session data or request bodies', async () => {
    await onRequest(
      context('/blog/first-post?token=super-secret&email=person%40example.test', {
        headers: {
          cookie: 'session=0123456789abcdef0123456789abcdef',
          authorization: 'Bearer top-secret-token',
        },
      }),
      nextReturning(200),
    );

    const output = stdout.join('');
    expect(output).not.toContain('super-secret');
    expect(output).not.toContain('person@example.test');
    expect(output).not.toContain('0123456789abcdef');
    expect(output).not.toContain('top-secret-token');
    expect(parseRecords(stdout)[0].path).toBe('/blog/first-post');
  });

  it('caps a pathologically long path instead of logging it in full', async () => {
    const longPath = `/${'a'.repeat(600)}`;

    await onRequest(context(longPath), nextReturning(404));

    const [record] = parseRecords(stdout);
    expect(record.path).toBeDefined();
    expect(record.path!.length).toBeLessThanOrEqual(515);
    expect(record.path!.endsWith('...')).toBe(true);
    expect(record.status).toBe(404);
  });

  it('records an unhandled handler failure once and returns a correlated, safe 500', async () => {
    const next = vi.fn(async () => {
      throw new Error('render failed for /blog/first-post');
    });

    const response = await onRequest(context('/blog/first-post'), next as never);
    const body = await response.text();

    const errors = parseRecords(stderr);
    const access = parseRecords(stdout);
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    // The caller can quote the id from the response when reporting the failure.
    expect(response.headers.get('X-Request-Id')).toBe(access[0].requestId);
    expect(errors).toHaveLength(1);
    expect(access).toHaveLength(1);
    expect(errors[0].event).toBe('middleware.request.failed');
    expect(errors[0].level).toBe('error');
    expect(errors[0].requestId).toBe(access[0].requestId);
    expect(access[0].status).toBe(500);
    expect(access[0].level).toBe('warn');
    expect(body).not.toContain('render failed for');
    expect(body).not.toContain('at ');
    expect(`${stdout.join('')}${stderr.join('')}`).not.toContain('render failed for');
  });
});

describe('server error records', () => {
  it('omits request correlation when no request is being served', () => {
    logServerError('db.pool.idle_client_error', new Error('connection terminated'));

    const [record] = parseRecords(stderr);
    expect(record.level).toBe('error');
    expect(record.event).toBe('db.pool.idle_client_error');
    expect(record.requestId).toBeUndefined();
    expect(record.method).toBeUndefined();
    expect(record.path).toBeUndefined();
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps only an error name and SQLSTATE, never the message or stack', () => {
    const error = new Error('duplicate key value violates unique constraint "users_email_key"');
    Object.assign(error, { code: '23505' });

    logServerError('auth.register.failed', error);

    const [record] = parseRecords(stderr);
    expect(record.errorName).toBe('Error');
    expect(record.code).toBe('23505');
    const raw = stderr.join('');
    expect(raw).not.toContain('duplicate key');
    expect(raw).not.toContain('users_email_key');
    expect(raw).not.toContain('at ');
  });

  it('escapes control characters so one record stays on one line', () => {
    const error = new Error('line one\nline two\rline three');
    error.name = 'Evil\nName';

    logServerError('test.control_characters', error);

    const lines = stderr.join('').split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(parseRecords(stderr)[0].errorName).toBe('Error');
  });
});
