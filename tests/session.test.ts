// tests/session.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSession,
  deleteSession,
  generateSessionToken,
  getSessionCookie,
  hashSessionToken,
  validateSession,
  verifySessionToken,
} from '../src/lib/session';
import { pool } from '../src/lib/db';

vi.mock('../src/lib/db', () => ({
  pool: {
    query: vi.fn(),
    on: vi.fn(),
  },
}));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn().mockReturnValue('11111111-2222-3333-4444-555555555555'),
  };
});

const mockUserId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('session utility', () => {
  it('should generate a session token', () => {
    const token = generateSessionToken();
    expect(token).toBe('11111111222233334444555555555555'); // 32 hex chars from UUID without hyphens
  });

  it('should hash a session token', async () => {
    const hashed = await hashSessionToken('token123');
    expect(hashed).toBe('b13ae34b9231f95675ff502761b64aedd0c278f5b6e8730ce99b72f35b2ddfb0');
  });

  it('should verify a session token', async () => {
    const hashedToken = await hashSessionToken('token123');
    const isValid = await verifySessionToken('token123', hashedToken);
    expect(isValid).toBe(true);
    await expect(verifySessionToken('different-token', hashedToken)).resolves.toBe(false);
  });

  it('should create a session and return token and cookie', async () => {
    const result = await createSession(mockUserId);
    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('cookieString');
    expect(result.cookieString).toContain(`session=${result.token};`);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO sessions (token_hash, user_id, expires_at)'),
      [await hashSessionToken(result.token), mockUserId, expect.any(Date)],
    );
  });

  it('should validate a session and return userId', async () => {
    // Mock the query to return a user_id
    pool.query.mockResolvedValueOnce({ rows: [{ user_id: mockUserId }], rowCount: 1 });
    const userId = await validateSession('token123');
    expect(userId).toBe(mockUserId);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE token_hash = $1 AND expires_at > NOW()'),
      [await hashSessionToken('token123')],
    );
  });

  it('should return null for invalid session', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const userId = await validateSession('invalid');
    expect(userId).toBeNull();
  });

  it('should delete a session', async () => {
    await deleteSession('token123');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM sessions'),
      [await hashSessionToken('token123')],
    );
  });

  it.each([
    ['not-session=bogus', undefined],
    ['session-extra=bogus', undefined],
    ['theme=dark; session=valid-token', 'valid-token'],
    ['session=valid-token; theme=dark', 'valid-token'],
    ['not-session=bogus; theme=dark; session=valid-token', 'valid-token'],
    ['session=token=with=equals; theme=dark', 'token=with=equals'],
  ])('reads only the exact session cookie from %s', (cookie, expected) => {
    const request = new Request('https://example.test', {
      headers: { cookie },
    });

    expect(getSessionCookie(request)).toBe(expected);
  });
});