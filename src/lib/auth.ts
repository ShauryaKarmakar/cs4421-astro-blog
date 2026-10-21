// src/lib/auth.ts
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

/**
 * A pre-computed dummy bcrypt hash using 12 salt rounds.
 * Used for constant-time comparison when an email is not found during login,
 * ensuring timing differences cannot be used for user enumeration.
 */
export const DUMMY_PASSWORD_HASH =
  '$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';

/**
 * Hash a plain text password
 * @param password - plain text password
 * @returns hashed password
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  return bcrypt.hash(password, salt);
}

/**
 * Compare a plain text password with its hash
 * @param password - plain text password
 * @param hashed - hashed password
 * @returns true if password matches
 */
export async function verifyPassword(password: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(password, hashed);
}

export default {
  hashPassword,
  verifyPassword,
  DUMMY_PASSWORD_HASH,
};
