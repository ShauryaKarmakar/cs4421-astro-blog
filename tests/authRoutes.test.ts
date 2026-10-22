import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { APIRoute } from 'astro';
import { pool } from '../src/lib/db';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../src/lib/auth';
import { APP_CURRENCY } from '../src/lib/currencyFormatting';
import { getSessionCookie, setSessionCookie } from '../src/lib/session';
import { authLimiter } from '../src/lib/rateLimiter';
import { logServerError } from '../src/lib/serverLogger';
import { POST as register } from '../src/pages/api/auth/register';
import { POST as login } from '../src/pages/api/auth/session';

vi.mock('../src/lib/db', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));

vi.mock('../src/lib/auth', () => ({
  DUMMY_PASSWORD_HASH: '$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234',
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock('../src/lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/session')>();
  return {
    ...actual,
    deleteSession: vi.fn(),
    setSessionCookie: vi.fn((response: Response, cookie: string) => {
      response.headers.set('Set-Cookie', cookie);
    }),
  };
});

vi.mock('../src/lib/rateLimiter', () => ({
  authLimiter: { checkLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 900 })) },
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../src/lib/serverLogger', () => ({
  logServerError: vi.fn(),
}));

const validEmail = 'person@example.test';
const validPassword = 'correct-horse-battery';
const user = {
  id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  email: validEmail,
  password_hash: 'stored-hash',
  created_at: new Date('2026-10-21T00:00:00.000Z'),
};

function setupRegistrationClient(failAt?: 'profiles' | 'sessions') {
  const committed = { users: 0, profiles: 0, sessions: 0 };
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let pending: typeof committed | undefined;
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql === 'BEGIN') {
      pending = { users: 0, profiles: 0, sessions: 0 };
      return { rows: [], rowCount: null };
    }
    if (sql === 'ROLLBACK') {
      pending = undefined;
      return { rows: [], rowCount: null };
    }
    if (sql === 'COMMIT') {
      Object.assign(committed, pending);
      pending = undefined;
      return { rows: [], rowCount: null };
    }
    if (sql.includes('SELECT id FROM users')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO users')) {
      if (!pending) throw new Error('User insert ran outside a transaction.');
      pending.users += 1;
      return { rows: [user], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO profiles')) {
      if (failAt === 'profiles') throw new Error('profile write failed');
      if (!pending) throw new Error('Profile insert ran outside a transaction.');
      pending.profiles += 1;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO sessions')) {
      if (failAt === 'sessions') throw new Error('session write failed');
      if (!pending) throw new Error('Session insert ran outside a transaction.');
      pending.sessions += 1;
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Unexpected registration query.');
  });
  const release = vi.fn();
  vi.mocked(pool.connect).mockResolvedValue({ query, release } as never);
  return { committed, query, release, calls };
}

function request(body: string, cookie?: string): Request {
  return new Request('https://example.test/api/auth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body,
  });
}

function context(handler: APIRoute, body: string, cookie?: string) {
  return { request: request(body, cookie) } as Parameters<typeof handler>[0];
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authLimiter.checkLimit).mockReturnValue({
    allowed: true,
    remaining: 4,
    resetTime: Date.now() + 60_000,
    retryAfterSeconds: 60,
  });
  vi.mocked(hashPassword).mockResolvedValue('new-password-hash');
  vi.mocked(verifyPassword).mockResolvedValue(true);
});

const invalidBodies: Array<[string, string]> = [
  ['{invalid json', 'malformed JSON'],
  ['null', 'null JSON'],
  ['{}', 'missing credentials'],
  ['{"email":7,"password":"correct-horse-battery"}', 'non-string email'],
  ['{"email":"person@example.test","password":7}', 'non-string password'],
  ['{"email":"   ","password":"correct-horse-battery"}', 'blank email'],
  ['{"email":"person@example.test","password":""}', 'empty password'],
];

describe.each([
  ['registration', register],
  ['login', login],
] as const)('%s route input validation', (_name, handler) => {
  it.each(invalidBodies)('rejects %s (%s) with 400 before database access', async (body) => {
    const response = await handler(context(handler, body));

    expect(response.status).toBe(400);
    expect(await responseBody(response)).toHaveProperty('error');
    expect(pool.query).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();
  });
});

describe('authentication route rate limiting responses', () => {
  it.each([
    ['registration', register],
    ['login', login],
  ] as const)('%s returns consistent 429 JSON with Retry-After header', async (_name, handler) => {
    vi.mocked(authLimiter.checkLimit).mockReturnValueOnce({
      allowed: false,
      remaining: 0,
      resetTime: Date.now() + 45_000,
      retryAfterSeconds: 45,
    });

    const response = await handler(
      context(handler, JSON.stringify({ email: validEmail, password: validPassword })),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Retry-After')).toBe('45');
    const body = await responseBody(response);
    expect(body).toEqual({ error: 'Too many requests, please try again later.' });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('registration route password length bounds and connection starvation prevention', () => {
  it('rejects passwords shorter than 8 characters before database access or hashing', async () => {
    const response = await register(
      context(register, JSON.stringify({ email: validEmail, password: 'short' })),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await responseBody(response)).toEqual({
      error: 'Password must be at least 8 characters long',
    });
    expect(hashPassword).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects passwords exceeding 72 bytes before database access or hashing', async () => {
    const longPassword = 'a'.repeat(73);
    const response = await register(
      context(register, JSON.stringify({ email: validEmail, password: longPassword })),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await responseBody(response)).toEqual({
      error: 'Password must not exceed 72 bytes.',
    });
    expect(hashPassword).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('computes password hash before acquiring a pool connection', async () => {
    let hashCompletedAt = -1;
    let connectionAcquiredAt = -1;
    let sequence = 0;

    vi.mocked(hashPassword).mockImplementation(async () => {
      hashCompletedAt = ++sequence;
      return 'hashed-password';
    });

    const { query, release } = setupRegistrationClient();
    vi.mocked(pool.connect).mockImplementation(async () => {
      connectionAcquiredAt = ++sequence;
      return { query, release } as never;
    });

    const response = await register(
      context(register, JSON.stringify({ email: validEmail, password: validPassword })),
    );

    expect(response.status).toBe(201);
    expect(hashCompletedAt).toBeGreaterThan(0);
    expect(connectionAcquiredAt).toBeGreaterThan(hashCompletedAt);
  });
});

describe('authentication route valid requests', () => {
  it('registers a normalized email and preserves password hashing and session cookie behavior', async () => {
    const { committed, calls } = setupRegistrationClient();

    const response = await register(
      context(
        register,
        JSON.stringify({ email: ' Person@Example.Test ', password: validPassword }),
      ),
    );

    expect(response.status).toBe(201);
    expect(await responseBody(response)).toMatchObject({
      user: { id: user.id, email: validEmail },
    });
    expect(hashPassword).toHaveBeenCalledWith(validPassword);
    expect(committed).toEqual({ users: 1, profiles: 1, sessions: 1 });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO profiles (user_id, currency, timezone)'),
      values: [user.id, APP_CURRENCY, 'UTC'],
    });
    expect(setSessionCookie).toHaveBeenCalledWith(response, expect.stringContaining('HttpOnly'));
    expect(response.headers.get('Set-Cookie')).toContain('SameSite=Strict');
    const cookieHeader = response.headers.get('Set-Cookie');
    expect(cookieHeader).toBeTruthy();
    expect(
      getSessionCookie(new Request('https://example.test/dashboard', {
        headers: { cookie: cookieHeader! },
      })),
    ).toMatch(/^[0-9a-f]{32}$/);

    const registrationPage = await readFile(
      new URL('../src/pages/register.astro', import.meta.url),
      'utf8',
    );
    expect(registrationPage).toMatch(
      /if \(response\.ok\) \{\s*window\.location\.href = '\/dashboard';/,
    );
  });

  it.each(['profiles', 'sessions'] as const)(
    'rolls back account creation when the %s write fails',
    async (failAt) => {
      const { committed, query, release } = setupRegistrationClient(failAt);

      const response = await register(
        context(register, JSON.stringify({ email: validEmail, password: validPassword })),
      );
      const body = await responseBody(response);

      expect(response.status).toBe(500);
      expect(body).toEqual({ error: 'Internal server error' });
      expect(JSON.stringify(body)).not.toContain(validPassword);
      expect(JSON.stringify(body)).not.toContain('new-password-hash');
      expect(JSON.stringify(body)).not.toContain('profile write failed');
      expect(JSON.stringify(body)).not.toContain('session write failed');
      expect(committed).toEqual({ users: 0, profiles: 0, sessions: 0 });
      expect(query).toHaveBeenCalledWith('ROLLBACK');
      expect(release).toHaveBeenCalledOnce();
      expect(setSessionCookie).not.toHaveBeenCalled();
      expect(logServerError).toHaveBeenCalledWith('auth.register.failed', expect.any(Error));
    },
  );

  it('logs in with a normalized email and sets a session cookie', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [user], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const response = await login(
      context(
        login,
        JSON.stringify({ email: ' Person@Example.Test ', password: validPassword }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await responseBody(response)).toMatchObject({
      user: { id: user.id, email: validEmail },
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM users WHERE email = $1'),
      [validEmail],
    );
    expect(verifyPassword).toHaveBeenCalledWith(validPassword, user.password_hash);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO sessions'),
      [expect.any(String), user.id, expect.any(Date)],
    );
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(response.headers.get('Set-Cookie')).toContain('SameSite=Strict');
  });

  it('verifies dummy hash to prevent user enumeration when email does not exist', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const response = await login(
      context(
        login,
        JSON.stringify({ email: 'nonexistent@example.test', password: validPassword }),
      ),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await responseBody(response)).toEqual({
      error: 'Invalid email or password',
    });
    // Verifies dummy password hash was compared to equalize timing
    expect(verifyPassword).toHaveBeenCalledWith(validPassword, DUMMY_PASSWORD_HASH);
  });
});
