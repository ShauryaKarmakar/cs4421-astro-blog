// src/lib/session.ts
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db';

const SESSION_TABLE = 'sessions';
const SESSION_TOKEN_BYTES = 32; // 32 bytes -> 64 hex characters

// Generate a random session token (hex string)
export function generateSessionToken(): string {
  return randomUUID().replace(/-/g, '').substring(0, SESSION_TOKEN_BYTES * 2);
}

// Hash a session token (for storage)
export async function hashSessionToken(token: string): Promise<string> {
  return createHash('sha256').update(token).digest('hex');
}

// Compare a plain token with its hash
export async function verifySessionToken(token: string, hashedToken: string): Promise<boolean> {
  return (await hashSessionToken(token)) === hashedToken;
}

// Create a new session for a user
export async function createSession(
  userId: string,
  expiresInSeconds = 24 * 60 * 60,
  queryable: Pick<PoolClient, 'query'> = pool,
): Promise<{ token: string; cookieString: string }> {
  const token = generateSessionToken();
  const hashedToken = await hashSessionToken(token);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  const query = `
    INSERT INTO ${SESSION_TABLE} (token_hash, user_id, expires_at)
    VALUES ($1, $2, $3)
    RETURNING id;
  `;
  const values = [hashedToken, userId, expiresAt];

  await queryable.query(query, values);

  // Create cookie string
  // In production, we should set Secure flag based on NODE_ENV
  const secure = process.env.NODE_ENV === 'production';
  const cookie = `session=${token}; HttpOnly; SameSite=Strict; Path=/; ${secure ? 'Secure; ' : ''}Max-Age=${expiresInSeconds}`;

  return { token, cookieString: cookie };
}

// Validate a session token and return the user ID if valid
export async function validateSession(token: string): Promise<string | null> {
  if (!token) return null;

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

// Get the session token from the request cookies
export function getSessionCookie(request: Request): string | undefined {
  const cookieHeader = request.headers.get('cookie') || '';
  const cookies = cookieHeader.split(';').map(c => c.trim()).map(c => {
    const [key, ...valueParts] = c.split('=');
    return [key.trim(), valueParts.join('=').trim()];
  });
  const sessionCookie = cookies.find(([key]) => key === 'session');
  return sessionCookie ? sessionCookie[1] : undefined;
}

// Set the session cookie on the response
export function setSessionCookie(response: Response, cookieString: string): void {
  response.headers.set('Set-Cookie', cookieString);
}

// Clear the session cookie
export function clearSessionCookie(response: Response): void {
  // Set an expired cookie to remove it
  response.headers.set('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

export default {
  generateSessionToken,
  hashSessionToken,
  verifySessionToken,
  createSession,
  validateSession,
  deleteSession,
  deleteSessionsForUser,
  getSessionCookie,
  setSessionCookie,
  clearSessionCookie,
};