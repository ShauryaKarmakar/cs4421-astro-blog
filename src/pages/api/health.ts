import type { APIRoute } from 'astro';
import { assertApplicationRole, healthPool } from '../../lib/db';
import { logServerError } from '../../lib/serverLogger';

const healthHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

async function checkDatabase(): Promise<void> {
  // The middleware lets this endpoint through so it can report dependency
  // health itself, so the production role assertion has to run here too and
  // fails closed with the same 503 as a failed query.
  await assertApplicationRole();
  // healthPool sets a two-second server-side statement_timeout and a 2.5s
  // client read timeout, so the query is cancelled rather than merely raced.
  await healthPool.query('SELECT 1');
}

export const GET: APIRoute = async () => {
  try {
    await checkDatabase();
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: healthHeaders,
    });
  } catch (error) {
    logServerError('health.database.failed', error);
    return new Response(JSON.stringify({ status: 'unavailable' }), {
      status: 503,
      headers: healthHeaders,
    });
  }
};
