// src/pages/api/auth/me.ts
import type { APIRoute } from 'astro';
import { pool } from '@/lib/db';
import { getSessionCookie, validateSession } from '@/lib/session';
import { logServerError } from '@/lib/serverLogger';

export const GET: APIRoute = async ({ request }) => {
  try {
    // Get the session token from cookies
    const token = getSessionCookie(request);
    if (!token) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401 }
      );
    }

    // Validate the session
    const userId = await validateSession(token);
    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401 }
      );
    }

    // Fetch the user and profile
    const res = await pool.query(
      `SELECT u.id, u.email, u.created_at, p.currency, p.timezone, p.university, p.course, p.academic_year, p.city, p.country
       FROM users u
       LEFT JOIN profiles p ON u.id = p.user_id
       WHERE u.id = $1`,
      [userId]
    );

    if (res.rowCount === 0) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 404 }
      );
    }

    const user = res.rows[0];

    // Return safe user info (no password hash)
    const userInfo = {
      id: user.id,
      email: user.email,
      createdAt: user.created_at,
      profile: {
        currency: user.currency,
        timezone: user.timezone,
        university: user.university,
        course: user.course,
        academicYear: user.academic_year,
        city: user.city,
        country: user.country,
      },
    };

    return new Response(JSON.stringify({ user: userInfo }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    logServerError('auth.me.failed', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500 }
    );
  }
};