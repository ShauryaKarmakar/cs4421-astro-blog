// src/middleware/auth.ts
import { randomUUID } from 'node:crypto';
import { defineMiddleware } from 'astro:middleware';
import { assertApplicationRole } from '../lib/db';
import { runWithRequestContext } from '../lib/requestContext';
import { logRequest, logServerError } from '../lib/serverLogger';
import { getSessionCookie, validateSession } from '../lib/session';

// Accept a caller-supplied correlation id only when it is short and made of
// log-safe characters. Anything else is replaced, so a header value cannot
// inject newlines or unbounded text into a structured log record.
const requestIdPattern = /^[A-Za-z0-9._-]{8,64}$/;

function resolveRequestId(request: Request): string {
  const supplied = request.headers.get('x-request-id');
  return supplied && requestIdPattern.test(supplied) ? supplied : randomUUID();
}

/**
 * Adds the correlation id to the response so a reported failure can be matched
 * to its log record. A redirect created by the framework has immutable
 * headers, so fall back to a copy in that case.
 */
function withRequestId(response: Response, requestId: string): Response {
  try {
    response.headers.set('X-Request-Id', requestId);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set('X-Request-Id', requestId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

export const onRequest = defineMiddleware((context, next) => {
  const pathname = new URL(context.request.url).pathname;
  const method = context.request.method;
  const requestId = resolveRequestId(context.request);
  const startedAt = performance.now();

  const handle = async (): Promise<Response> => {
    // The health endpoints report their own state, so they must reach their
    // handlers even when the database is unreachable. Readiness (/api/health)
    // checks PostgreSQL and liveness (/api/live) deliberately does not; the role
    // gate below would otherwise replace either payload with a generic 503.
    if (pathname === '/api/health' || pathname === '/api/live') {
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
  };

  return runWithRequestContext({ requestId, method, path: pathname }, async () => {
    try {
      const response = await handle();
      // The access record carries the route, method, status, and latency. Error
      // records written while this request runs share the same requestId, so a
      // failure can be traced from the alarm to the exact request.
      logRequest({
        requestId,
        method,
        path: pathname,
        status: response.status,
        durationMs: performance.now() - startedAt,
      });
      return withRequestId(response, requestId);
    } catch (error) {
      // One error record for the failure and one access record for the
      // response, sharing the request id. Returning the response instead of
      // rethrowing keeps the failure safe and correlatable: the framework's
      // error path is free to render a stack trace, and a thrown error would
      // also leave the caller without the X-Request-Id header.
      logServerError('middleware.request.failed', error);
      const response = new Response(
        'Something went wrong. Please try again later.',
        {
          status: 500,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        },
      );
      logRequest({
        requestId,
        method,
        path: pathname,
        status: 500,
        durationMs: performance.now() - startedAt,
      });
      return withRequestId(response, requestId);
    }
  });
});
