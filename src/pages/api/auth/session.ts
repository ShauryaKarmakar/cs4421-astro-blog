// src/pages/api/auth/session.ts
import type { APIRoute } from 'astro';
import { pool } from '@/lib/db';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '@/lib/auth';
import { parseCredentials } from '@/lib/authApi';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  getSessionCookie,
  setSessionCookie,
} from '@/lib/session';
import { authLimiter, getClientIP } from '@/lib/rateLimiter';
import { logServerError } from '@/lib/serverLogger';

export const POST: APIRoute = async ({ request }) => {
  // Rate limiting by IP
  const ip = getClientIP(request);
  const { allowed, retryAfterSeconds } = authLimiter.checkLimit(`login:${ip}`);
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: 'Too many requests, please try again later.' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfterSeconds),
        },
      }
    );
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: 'Request body must contain valid JSON.' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const validation = parseCredentials(body);
    if (!validation.valid) {
      return new Response(JSON.stringify({ error: validation.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const { email, password } = validation.value;

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Find the user by email
    const userRes = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [normalizedEmail]
    );

    const user = userRes.rows[0];

    // Mitigate user enumeration timing attack: run verifyPassword even if user not found
    const passwordHashToVerify = user
      ? user.password_hash
      : DUMMY_PASSWORD_HASH;

    const isValid = await verifyPassword(password, passwordHashToVerify);
    if (!user || !isValid) {
      return new Response(
        JSON.stringify({ error: 'Invalid email or password' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // If there is an existing session, delete it (token rotation)
    const existingToken = getSessionCookie(request);
    if (existingToken) {
      await deleteSession(existingToken);
    }

    // Create a new session
    const { cookieString } = await createSession(user.id);

    // Create response with user info (safe)
    const userInfo = {
      id: user.id,
      email: user.email,
    };

    const response = new Response(JSON.stringify({ user: userInfo }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Set the session cookie
    setSessionCookie(response, cookieString);

    return response;
  } catch (err) {
    logServerError('auth.login.failed', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};

export const DELETE: APIRoute = async ({ request }) => {
  try {
    const token = getSessionCookie(request);
    if (token) {
      await deleteSession(token);
    }

    // Clear the cookie
    const response = new Response(null, { status: 204 });
    clearSessionCookie(response);
    return response;
  } catch (err) {
    logServerError('auth.logout.failed', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
