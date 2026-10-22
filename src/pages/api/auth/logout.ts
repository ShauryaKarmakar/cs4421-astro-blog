
import type { APIRoute } from 'astro';
import { deleteSession, getSessionCookie } from '@/lib/session';
import { logServerError } from '@/lib/serverLogger';

export const POST: APIRoute = async ({ cookies, redirect, request }) => {
  const expectsJson = request.headers.get('accept')?.includes('application/json') ?? false;

  try {
    const sessionToken = getSessionCookie(request);

    if (sessionToken) {
      await deleteSession(sessionToken);
    }

    cookies.delete('session', { path: '/' });

    if (expectsJson) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return redirect('/login', 303);
  } catch (error) {
    logServerError('auth.logout.failed', error);

    if (expectsJson) {
      return new Response(JSON.stringify({ error: 'Unable to sign out' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Unable to sign out. Please try again.', { status: 500 });
  }
};
