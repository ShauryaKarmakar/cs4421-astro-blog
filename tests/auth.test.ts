// tests/auth.test.ts
import { describe, it, expect, vi } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/auth';

// Mock bcryptjs with default export
vi.mock('bcryptjs', () => ({
  __esModule: true,
  default: {
    genSalt: vi.fn().mockResolvedValue('salt'),
    hash: vi.fn().mockResolvedValue('hashedPassword'),
    compare: vi.fn().mockResolvedValue(true),
  },
}));

describe('auth utility', () => {
  it('should hash a password', async () => {
    const hash = await hashPassword('password123');
    expect(hash).toBe('hashedPassword');
  });

  it('should verify a password', async () => {
    const isValid = await verifyPassword('password123', 'hashedPassword');
    expect(isValid).toBe(true);
  });
});