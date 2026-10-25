import type { APIRoute } from 'astro';

// Process liveness only. ECS stops and replaces a task whose container health
// check fails, so this endpoint must never depend on PostgreSQL: a database
// outage has to read as "stop routing traffic to this target", not as "the
// task is dead, replace it". Database readiness stays on /api/health, which
// the load balancer target group probes.
//
// The middleware lets this path through so the production role gate cannot
// replace this payload with a generic 503. Nothing here touches the database,
// so there is nothing to disclose about it.
const livenessHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

export const GET: APIRoute = () =>
  new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: livenessHeaders,
  });
