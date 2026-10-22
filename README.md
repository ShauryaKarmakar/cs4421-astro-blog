# UniBudget

UniBudget is a server-rendered Astro application for managing transactions and
overall monthly budgets. It uses the Astro Node standalone adapter and
PostgreSQL for user, session, transaction, and budget data.

## Requirements

- Node.js 22.12 or newer
- npm
- PostgreSQL for local application use

## Local development

```powershell
npm ci
$env:DATABASE_URL = "postgresql://USER:PASSWORD@HOST:5432/DATABASE"
npm run dev
```

Apply the SQL migrations in `migrations/` in their numbered order to a new local
database. Do not apply them to a database containing existing application data
without first reviewing its schema and backing it up. See
[deployment and migration guidance](./docs/deployment.md) for the controlled
migration procedure.

## Quality checks

```powershell
npm run check
npm run lint
npm test -- --run
npm run build
```

The AWS CDK application is in `hello-cdk/`. Its build, tests, and synthesis
commands are documented in [deployment guidance](./docs/deployment.md).

## Production

The root [dockerfile](./dockerfile) builds and runs the Astro standalone Node
server. The application requires PostgreSQL configuration through
`DATABASE_URL` or the standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and
`PGPASSWORD` variables. Never commit credentials or `.env` files.

The repository does not currently deploy to AWS automatically. Review
[deployment and migration guidance](./docs/deployment.md) before provisioning
or migrating any environment.
