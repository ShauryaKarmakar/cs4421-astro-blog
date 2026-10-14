// src/lib/session.ts
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from './db';

const SESSION_TABLE = 'sessions';
const SESSION_TOKEN_BYTES = 32; // 32 bytes -> 64 hex characters

// Generate a random session token (hex string)
export function generateSessionToken(): string {
  return randomUUID().replace(/-/g, '').substring(0, SESSION_TOKEN_BYTES * 2);
}

// Hash a session token (for storage)
export async function hashSessionToken(token: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(token, salt);
}

// Compare a plain token with its hash
export async function verifySessionToken(token: string, hashedToken: string): Promise<boolean> {
  return bcrypt.compare(token, hashedToken);
}

// Create a new session for a user
export async function createSession(userId: string, expiresInSeconds = 24 * 60 * 60): Promise<{ token: string; cookieString: string }> {
  const token = generateSessionToken();
  const hashedToken = await hashSessionToken(token);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  const query = `
    INSERT INTO ${SESSION_TABLE} (token_hash, user_id, expires_at)
    VALUES ($1, $2, $3)
    RETURNING id;
  `;
  const values = [hashedToken, userId, expiresAt];

  await pool.query(query, values);

  // Create cookie string
  // In production, we should set Secure flag based on NODE_ENV
  const secure = process.env.NODE_ENV === 'production';
  const cookie = `session=${token}; HttpOnly; SameSite=Strict; Path=/; ${secure ? 'Secure; ' : ''}Max-Age=${expiresInSeconds}`;

  return { token, cookieString: cookie };
}

// Validate a session token and return the user ID if valid
export async function validateSession(token: string): Promise<string | null> {
  if (!token) return null;

  // We need to hash the token to compare with the stored hash
  // However, we cannot reverse the hash, so we must look up the session by token hash?
  // But we don't have the hash of the token until we hash it, and we need to compare.
  // Alternative: store the token hash and then hash the incoming token and compare.
  // But we cannot index by hash because we don't have the hash of the incoming token until we compute it.
  // So we must retrieve all sessions for the user? Not efficient.

  // Instead, we can store the token (not hashed) in a secure way? But that's a security risk if the DB is leaked.

  // Another approach: use a random token that we store as is, and then use a signed cookie so we can verify the token without hitting the DB for every request?
  // But we still need to validate the token is in the DB to prevent token theft.

  // We can do: store a random token (plain) in the DB, and sign the cookie with a secret. Then we can verify the cookie signature and extract the token, then look up the token in the DB.
  // However, the task says to store only a hash of the session token in the database.

  // Let's change: we will store a hash of the token, and to validate we must hash the incoming token and then compare with the stored hash.
  // But we need to find the session by the hash of the token. We can compute the hash of the incoming token and then look up by that hash.
  // However, we cannot use the hash as a lookup key because we don't have an index on token_hash? We can add an index.

  // We'll change the session table to have an index on token_hash.

  // For now, we'll assume we have an index on token_hash and we can do:
  const hashedToken = await hashSessionToken(token);
  const query = `
    SELECT user_id FROM ${SESSION_TABLE}
    WHERE token_hash = $1 AND expires_at > NOW()
  `;
  const values = [hashedToken];

  const res = await pool.query(query, values);
  if (res.rowCount === 0) {
    return null;
  }
  return res.rows[0].user_id;
}

// Delete a session by token
export async function deleteSession(token: string): Promise<void> {
  const hashedToken = await hashSessionToken(token);
  const query = `
    DELETE FROM ${SESSION_TABLE}
    WHERE token_hash = $1
  `;
  const values = [hashedToken];
  await pool.query(query, values);
}

// Delete all sessions for a user (e.g., on password change)
export async function deleteSessionsForUser(userId: string): Promise<void> {
  const query = `
    DELETE FROM ${SESSION_TABLE}
    WHERE user_id = $1
  `;
  const values = [userId];
  await pool.query(query, values);
}

export default {
  generateSessionToken,
  hashSessionToken,
  verifySessionToken,
  createSession,
  validateSession,
  deleteSession,
  deleteSessionsForUser,
};