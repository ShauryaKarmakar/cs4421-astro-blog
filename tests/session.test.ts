// tests/session.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSessionToken, hashSessionToken, verifySessionToken, createSession, validateSession, deleteSession } from '../src/lib/session';
import { pool } from '../src/lib/db';

vi.mock('../src/lib/db', () => ({
  pool: {
    query: vi.fn(),
    on: vi.fn(),
  },
}));
vi.mock('bcryptjs', () => ({
  __esModule: true,
  default: {
    genSalt: vi.fn().mockResolvedValue('salt'),
    hash: vi.fn().mockImplementation((token) => Promise.resolve(`hashed_${token}`)),
    compare: vi.fn().mockImplementation((token, hashed) => Promise.resolve(token === hashed.replace('hashed_', ''))),
  },
}));
vi.mock('crypto', () => ({
  randomUUID: vi.fn().mockReturnValue('11111111-2222-3333-4444-555555555555'),
}));

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
    expect(hashed).toBe('hashed_token123');
  });

  it('should verify a session token', async () => {
    const isValid = await verifySessionToken('token123', 'hashed_token123');
    expect(isValid).toBe(true);
  });

  it('should create a session and return token and cookie', async () => {
    const result = await createSession(mockUserId);
    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('cookieString');
    expect(pool.query).toHaveBeenCalled();
  });

  it('should validate a session and return userId', async () => {
    // Mock the query to return a user_id
    pool.query.mockResolvedValueOnce({ rows: [{ user_id: mockUserId }], rowCount: 1 });
    const userId = await validateSession('token123');
    expect(userId).toBe(mockUserId);
    expect(pool.query).toHaveBeenCalled();
  });

  it('should return null for invalid session', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const userId = await validateSession('invalid');
    expect(userId).toBeNull();
  });

  it('should delete a session', async () => {
    await deleteSession('token123');
    expect(pool.query).toHaveBeenCalled();
  });
});