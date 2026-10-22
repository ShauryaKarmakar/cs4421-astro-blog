# AWS deployment and database migration guide

## Architecture and deployment status

The CDK app in `hello-cdk/` defines an internet-facing Application Load
Balancer, an ECS Fargate service, an ECR repository, a VPC, and an encrypted
PostgreSQL RDS instance. RDS is in isolated subnets and its security group
allows PostgreSQL only from the application security group. The application
uses a dedicated `unibudget_app` database role and a generated
Secrets Manager secret. The application task execution role can read only that
application secret, pull the image, and write CloudWatch logs. A separate
migration task definition receives both the RDS administrator secret and the
application-role secret. The normal application task does not receive the
administrator credential.

The one-off migration runner creates or updates `unibudget_app` after applying
the schema. It limits that role to `CONNECT`, schema `USAGE`, and
`SELECT`/`INSERT`/`UPDATE`/`DELETE` on the application tables. It removes other
direct database, schema, table, and sequence grants in `public`, resets
elevated role attributes, and fails if the role has memberships or owns
public-schema objects. It does not grant access to the migration ledger or the
legacy category-budget archive. Future application tables require an explicit
grant update before the application uses them.

The generated application password is supplied only to the migration task and
is used to provision the role; the runner does not print it. Do not enable
PostgreSQL statement or bind-parameter logging that captures credential
provisioning. Keep the RDS administrator secret available only to the
migration execution role and authorized operators.

The Fargate tasks currently use public subnets and public IP addresses to avoid
NAT Gateway cost. Their security group accepts application traffic only from
the load balancer. The database has no public route. This is a cost-conscious
demo trade-off, not a claim that application tasks are in private subnets.

Deployment is deliberately not automated. The CI workflow validates the
application, container build, and CDK template but does not authenticate to
AWS, provision resources, or deploy on pushes or pull requests.

## Prerequisites and configuration

Before deployment, decide and confirm the AWS account, region, environment,
expected traffic, budget, and data-retention requirements. Set
`UNIBUDGET_AWS_ACCOUNT` and `UNIBUDGET_AWS_REGION` explicitly for deployment;
the CDK app rejects setting only one. Synthesis without either variable is
environment-agnostic and supported for local validation without AWS lookups.

For HTTPS, create or import an ACM certificate in the same region as the
Application Load Balancer, and configure a domain's DNS record to point to the
ALB. Pass its ARN through CDK context as `certificateArn`. Without a
certificate, the demo listener is HTTP-only. Do not use HTTP for production
authentication or session traffic.

The stack's default ECS desired count is zero so that the initial infrastructure
can be prepared without starting a task that references an image not yet
published. The image tag defaults to `bootstrap`; ECR tags are immutable.
Use `bootstrap` for the initial stack and migration task, then publish a new
immutable release tag and update the stack to that tag when enabling the
service.

## Fresh database initialization

For a newly provisioned, empty RDS database:

1. Review the four SQL files under `migrations/` and the migration runner at
   `scripts/migrate.mjs`.
2. Build and publish the application image, then launch a one-off ECS task using
   the `MigrationTaskDefinitionArn`, subnets, security group, and configured
   secret injection. Wait for it to exit successfully and inspect its
   CloudWatch migration log stream before starting the web service.
3. Start the ECS service with a desired count greater than zero, using the
   same image tag that the task definition references. Confirm that the ALB
   target is healthy and review application logs.

The migration runner uses numbered, sorted SQL files, a PostgreSQL advisory
lock, per-file transactions, and a `schema_migrations` ledger. It fails if it
finds a `users` table without a ledger or ledger entries absent from the image.
It is a deliberate one-off operation and is not part of container startup.
The runtime image includes the migration SQL and runner for this task. Run it
from the separate migration task definition attached to the same VPC and
application security group. Its command already runs
`node ./scripts/migrate.mjs`; do not use the application task definition for
migrations. Never make RDS public to reach it. The normal container entry point is
`scripts/start.mjs`, which starts Astro's generated `dist/server/entry.mjs` and
gracefully closes the HTTP server on `SIGTERM`/`SIGINT`. The migration task
does not start the web server.

Both the app and migrator require `PGSSLMODE=verify-full` (or the corresponding
`MIGRATION_PGSSLMODE`) and the CA bundle at
`/etc/ssl/certs/rds-global-bundle.pem`. The Docker build downloads the public
AWS RDS global CA bundle from
`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` over
HTTPS, validates that the response is PEM, and copies it into the runtime
image. The Node PostgreSQL driver loads that CA and sets
`rejectUnauthorized: true`; the driver also checks the RDS endpoint hostname
against the certificate. Do not connect by IP, disable verification, or add an
unverified TLS fallback. Rebuild the image from the official bundle source
when AWS rotates the RDS CA.

For a new empty database, the migration task uses the administrator login only
to apply migrations and provision the application role. The web task logs in as
`unibudget_app`. Subsequent controlled migration runs update the role password
to match the current application Secrets Manager value and reapply the grants.

The current migrations initialize users, sessions, profiles, transactions,
and monthly budgets. Migration 04 renames the old category-budget table to
`monthly_category_budgets_legacy`, aggregates its rows into the one-budget per
user/month table, and preserves the source rows. It does not create historical
budgets from missing data.

## Existing database adoption

Do not point this migration runner at an existing database as if it were fresh.
The runner intentionally refuses an existing `users` table without a migration
ledger. The local database schema is not evidence that RDS is at the same
migration level.

Before adopting existing data, take and verify a restorable backup, compare the
live schema and data with every migration, inspect the contents and intended
semantics of the legacy category-budget table, and write a reviewed baseline
and data-transfer plan. Decide how the ledger should represent already-applied
migrations and how identities, sessions, transactions, and budgets will be
preserved. Test the full procedure against a disposable copy and reconcile
row counts and financial totals. Do not manually insert ledger rows or run
migrations in production without an approved, tested plan and rollback/recovery
procedure.

Also review the current database's `public` schema privileges, database role
memberships and object ownership, and PostgreSQL default public-schema
permissions before adoption. The runner rejects an existing `unibudget_app`
role with memberships or public-schema ownership, but existing grants in other
schemas and databases must be audited explicitly. Back up both the database
and the administrator/application secrets; rotate the app secret and role
password together. Migration 04 runs within a transaction, but test the restore
and recovery procedure against a disposable backup copy first.

## Local validation

From the repository root:

```powershell
npm ci
npm run check
npm run lint
npm test -- --run
npm run build
docker build -f dockerfile -t unibudget:ssr .
docker run --rm -p 8080:8080 `
  -e PGHOST=$env:PGHOST -e PGUSER=$env:PGUSER `
  -e PGPASSWORD=$env:PGPASSWORD -e PGDATABASE=$env:PGDATABASE `
  -e PGSSLMODE=verify-full `
  -e PGSSLROOTCERT=/etc/ssl/certs/rds-global-bundle.pem `
  unibudget:ssr
```

The container needs a reachable PostgreSQL database to serve database-backed
routes; use a disposable test database with TLS, not production. Supply
credentials through your local secret manager/environment rather than typing
real values into shell history or source files.
Production mode requires `PGSSLMODE=verify-full` and `PGSSLROOTCERT` pointing at
the trusted CA bundle. The image includes the AWS RDS bundle at the path
configured in the CDK task definition.

## Disposable PostgreSQL integration tests

The PostgreSQL integration suite creates a randomized schema, applies
migrations 01–04 within that schema, and drops only that test schema during
cleanup. It accepts only the `unibudget_test` database on a loopback host or
the CI `postgres` service. Never point it at a production, shared, or valuable
database.

To run locally in PowerShell with Docker, create a uniquely named container,
use a generated test-only password, bind only to loopback, and wait for the
database health check before running tests:

```powershell
$containerName = "unibudget-test-postgres-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
if (docker ps -a --filter "name=^$containerName$" --format '{{.Names}}') {
  throw "Container name is already in use: $containerName"
}
$bytes = New-Object byte[] 24
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$testPassword = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
$rng.Dispose()
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$hostPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$containerStarted = $false
$testExit = 1
try {
  docker run --rm --detach --name $containerName `
    --publish "127.0.0.1:${hostPort}:5432" `
    -e POSTGRES_USER=unibudget_test_admin `
    -e "POSTGRES_PASSWORD=$testPassword" `
    -e POSTGRES_DB=unibudget_test `
    --health-cmd "pg_isready -U unibudget_test_admin -d unibudget_test" `
    --health-interval 2s --health-timeout 3s --health-retries 30 `
    postgres:16-bookworm
  if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable PostgreSQL.' }
  $containerStarted = $true
  $healthy = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $state = docker inspect --format '{{.State.Health.Status}}' $containerName
    if ($state -eq 'healthy') { $healthy = $true; break }
    if ($state -eq 'unhealthy') { throw 'Disposable PostgreSQL became unhealthy.' }
    Start-Sleep -Seconds 2
  }
  if (-not $healthy) { throw 'Timed out waiting for disposable PostgreSQL.' }
  $env:BUDGET_TEST_DATABASE_URL = "postgresql://unibudget_test_admin:${testPassword}@127.0.0.1:${hostPort}/unibudget_test"
  npm test -- --run
  $testExit = $LASTEXITCODE
}
finally {
  if ($containerStarted) { docker stop $containerName | Out-Null }
  Remove-Item Env:BUDGET_TEST_DATABASE_URL -ErrorAction SilentlyContinue
  $testPassword = $null
}
if ($testExit -ne 0) { throw "PostgreSQL test suite failed with exit code $testExit." }
```

The random password is test-only, the published port is loopback-only, and
`--rm` removes this container when it is stopped. Do not use an existing
database. In CI, a PostgreSQL 16 service is provisioned for the job and
`BUDGET_TEST_DATABASE_URL` is mandatory; the integration suite throws rather
than silently skipping if the CI variable is absent.

For CDK validation:

```powershell
Set-Location hello-cdk
npm ci
npm run build
npm test -- --runInBand
npx cdk synth --no-lookups
```

These commands build and synthesize templates locally; they do not create AWS
resources or perform AWS context lookups. Synthesis can be done without AWS
credentials.

## Deliberate deployment sequence (not automated)

After review and explicit authorization to deploy:

1. Bootstrap CDK for the approved account and region.
2. Deploy the stack with desired task count zero, image tag `bootstrap`, and
   the approved certificate ARN if HTTPS is configured.
3. Build the root `dockerfile` for the Fargate architecture, authenticate to
   the stack-created ECR repository, and push the immutable `bootstrap` tag.
4. Run and verify the one-off migration task as described above.
5. Build and push a new immutable release tag, then update the stack's image
   tag and desired task count to deploy the application service. Verify target
   health, HTTPS/domain routing, logs, authentication, database isolation, and
   budget/transaction behavior.
6. Record backups, operational ownership, recovery steps, and a tested
   maintenance window before accepting real user data.

Deployment commands are intentionally not included as a ready-to-run script:
the account, region, image architecture, certificate, service count, data
migration plan, costs, and target environment have not been confirmed. Do not
run `cdk deploy` or any AWS resource-changing command until those decisions and
authorization are complete. Do not use `cdk destroy` as routine cleanup.

If a future GitHub deployment workflow is introduced, use GitHub OIDC with a
repository/environment-scoped role, least-privilege permissions, protected
environments, and an explicit approval gate. Do not add long-lived AWS access
keys to GitHub secrets.

## Cost and lifecycle considerations

This stack intentionally retains the encrypted RDS instance, its generated
credential secret, ECR repository, and CloudWatch log group; RDS deletion
protection is enabled and automated backups are retained for seven days.
Retained resources can continue to incur cost after a stack update or
deletion. Never disable deletion protection or remove retained data without an
approved backup and data-retention decision.

Potential charges include:

- ALB hourly and capacity-unit charges, even while the service has zero tasks.
- RDS instance hours, provisioned storage, backup storage, and data transfer.
- Fargate vCPU/memory while tasks are running.
- Public IPv4 addresses attached to the load balancer and running tasks.
- ECR image storage and image scanning.
- CloudWatch log ingestion and storage.
- Data transfer, DNS, ACM/domain registration, and any future NAT Gateway.

The `db.t4g.micro`, single-AZ database, 20 GiB gp3 storage, one-week log
retention, no NAT Gateway, and zero initial task count lower the demo footprint
but do not make it free or production-resilient. Confirm current pricing for
the selected region before creating resources.
