# 0001 — Astro server rendering with the Node standalone adapter

- Status: Accepted
- Date: 2026-10-25

## Context

UniBudget serves per-user dashboards, transactional budget APIs, authenticated
sessions, and dynamic content routes. A static build cannot enforce sessions
or query PostgreSQL per request. The application also needs a container that
can run unchanged on a workstation and on ECS/Fargate.

## Decision

Render with Astro using its Node adapter in standalone mode. The production
image runs `node ./scripts/start.mjs`, which starts the generated
`dist/server/entry.mjs` server and handles SIGTERM/SIGINT with a bounded
graceful shutdown.

Dynamic routes resolve request data from `Astro.params` and the content layer
at request time. The deployed `/blog/:slug` route is SSR rather than a
prerendered page.

## Alternatives considered

- **Static Astro output** — rejected because authentication, budget APIs, and
  per-user data require request-time execution.
- **A separate SPA plus API service** — rejected as unnecessary operational
  and deployment complexity for this project.
- **A serverless adapter** — possible, but the ECS/Fargate target and the
  existing container build are already in place.

## Consequences

- The application needs a Node runtime, not only a static file host.
- The container is the deployable unit, and the server must shut down
  gracefully when ECS replaces a task.
- SSR route regressions can exist even when a static build succeeds, so
  post-deployment checks must request real routes such as `/blog/<slug>`.
- Session storage and database access are server-side concerns and must never
  be exposed to the browser.
