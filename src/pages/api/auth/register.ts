// src/pages/api/auth/register.ts
import type { APIRoute } from 'astro';
import { pool } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { MAX_REGISTRATION_PASSWORD_BYTES, parseCredentials } from '@/lib/authApi';
import { APP_CURRENCY } from '@/lib/currencyFormatting';
import { createSession, setSessionCookie } from '@/lib/session';
import { authLimiter, getClientIP } from '@/lib/rateLimiter';
import { logServerError } from '@/lib/serverLogger';

export const POST: APIRoute = async ({ request }) => {
  // Rate limiting by IP
  const ip = getClientIP(request);
  const { allowed, retryAfterSeconds } = authLimiter.checkLimit(`register:${ip}`);
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
    const normalizedEmail = email.toLowerCase().trim();

    // Password length validation (minimum 8 characters, maximum 72 bytes for bcrypt)
    if (password.length < 8) {
      return new Response(
        JSON.stringify({ error: 'Password must be at least 8 characters long' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    if (Buffer.byteLength(password, 'utf8') > MAX_REGISTRATION_PASSWORD_BYTES) {
      return new Response(
        JSON.stringify({ error: 'Password must not exceed 72 bytes.' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Compute password hash BEFORE acquiring a database client or opening a transaction
    // to prevent holding pool connections during expensive CPU hashing
    const passwordHash = await hashPassword(password);

    const client = await pool.connect();
    let transactionStarted = false;
    let user: { id: string; email: string; created_at: Date | string };
    let cookieString: string;

    try {
      await client.query('BEGIN');
      transactionStarted = true;

      const existingUserRes = await client.query(
        'SELECT id FROM users WHERE email = $1',
        [normalizedEmail]
      );
      if ((existingUserRes.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return new Response(
          JSON.stringify({ error: 'Invalid email or password' }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      const userRes = await client.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
        [normalizedEmail, passwordHash]
      );
      user = userRes.rows[0];

      await client.query(
        'INSERT INTO profiles (user_id, currency, timezone) VALUES ($1, $2, $3)',
        [user.id, APP_CURRENCY, 'UTC']
      );

      ({ cookieString } = await createSession(user.id, undefined, client));
      await client.query('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          logServerError('auth.register.rollback.failed', rollbackError);
        }
      }
      throw error;
    } finally {
      client.release();
    }

    // Create response with user info (safe)
    const userInfo = {
      id: user.id,
      email: user.email,
      createdAt: user.created_at,
    };

    const response = new Response(JSON.stringify({ user: userInfo }), {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Set the session cookie
    setSessionCookie(response, cookieString);

    return response;
  } catch (err) {
    logServerError('auth.register.failed', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
