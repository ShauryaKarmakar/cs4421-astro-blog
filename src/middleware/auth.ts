// src/middleware/auth.ts
import { defineMiddleware } from 'astro:middleware';
import { assertApplicationRole } from '../lib/db';
import { logServerError } from '../lib/serverLogger';
import { getSessionCookie, validateSession } from '../lib/session';

export const onRequest = defineMiddleware(async (context, next) => {
  const pathname = new URL(context.request.url).pathname;

  // The health endpoint reports dependency health itself, so it must reach its
  // handler even when the database is unreachable. The role gate below would
  // otherwise replace the health payload with a generic 503.
  if (pathname === '/api/health') {
    return next();
  }

  try {
    await assertApplicationRole();
  } catch (error) {
    logServerError('middleware.database_role.failed', error);
    return new Response('Service temporarily unavailable. Please try again later.', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  // Define the protected paths
  const protectedPaths = ['/dashboard', '/transactions', '/budgets'];

  // Check if the current path starts with any of the protected paths
  const isProtected = protectedPaths.some((path) => pathname.startsWith(path));

  // If not a protected path, skip authentication
  if (!isProtected) {
    return next();
  }

  // Get the session token from cookies
  const token = getSessionCookie(context.request);
  if (!token) {
    // No session, redirect to login
    return context.redirect('/login');
  }

  // Validate the session
  let userId: string | null;
  try {
    userId = await validateSession(token);
  } catch (error) {
    logServerError('middleware.session_validation.failed', error);
    return new Response('Unable to verify your session. Please try again later.', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
  if (!userId) {
    // Invalid or expired session, redirect to login
    return context.redirect('/login');
  }

  // Attach the user ID to the context for use in endpoints or pages
  context.locals.userId = userId;

  // Continue to the next middleware or handler
  return next();
});