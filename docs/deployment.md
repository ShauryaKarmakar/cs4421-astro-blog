# AWS deployment and database migration guide

> Week 7 deliverable status, evidence, drills, and outstanding work:
> [week7-deliverables.md](week7-deliverables.md).
>
> Final release readiness and the deployment gate:
> [release-readiness.md](release-readiness.md). Architecture decisions:
> [docs/adr/README.md](adr/README.md).

## Architecture and scope

The production database is Supabase PostgreSQL, reached through its **session
pooler** on port `5432`. The pooler hostname is **not defaulted** anywhere: the
CDK stack requires the exact host copied from the Supabase dashboard's Database
Settings and rejects a scheme, port, path, or malformed hostname.

The application runs as an Astro Node standalone server on ECS Fargate behind
an Application Load Balancer, with images in ECR. The ALB is an HTTP origin
that accepts traffic only from the AWS-managed CloudFront origin-facing prefix
list. CloudFront terminates TLS on its AWS-generated `*.cloudfront.net`
hostname with the AWS-managed certificate, so the deployment needs no custom
domain, DNS record, or ACM certificate. Every viewer request is redirected to
HTTPS, and nothing is cached at the edge because the same host renders
per-user HTML and serves the login, session, and budget APIs.

Both the application and the one-off migration task run in public subnets with
public IPs so they can reach Supabase without a NAT Gateway. Their security
group accepts application traffic only from the load balancer.

The CDK app in `hello-cdk/` still defines the original encrypted RDS instance
and its retained secrets. Those resources are deliberately left in place: they
are not used by the application, but removing them before a snapshot and cost
decision could orphan a running database or break its security group. Do not
delete or replace the RDS resources, disable deletion protection, or change
their retention as part of the Supabase cutover.

The separate static S3/CloudFront deployment is not defined in this CDK app and
is not touched by these changes.

The application connects only as the dedicated `unibudget_app` role. The
application task execution role can read the application credentials and the
Supabase CA secret, pull the image, and write CloudWatch logs. The separate
migration task can also read the Supabase administrator secret and the
application password used to provision `unibudget_app`. The application task
never receives the administrator credential.

## Supabase configuration

### Secrets Manager entries

The CDK stack creates three empty Secrets Manager entries. Populate them after
the bootstrap stack exists and before running a migration. Never commit their
values or paste them into workflow files.

| Secret name | Contents |
| --- | --- |
| `unibudget/supabase/application` | JSON: `{"username":"unibudget_app.<project-ref>","password":"..."}` |
| `unibudget/supabase/migration` | JSON: `{"username":"postgres.<project-ref>","password":"..."}` |
| `unibudget/supabase/ca` | Plain-text PEM CA certificate downloaded from the project's Database Settings → SSL Configuration |

Use the **session pooler** usernames (port 5432), not the direct database host
or the transaction pooler on 6543: advisory locks, role changes, and grants
need a session. The application and migration roles use different credentials.
The application password must match the value used as `APP_DATABASE_PASSWORD`
by the migration task; the runner resets the role password to that value on
every run.

Populate secrets with a short-lived local file and the AWS CLI, for example:

```bash
aws secretsmanager put-secret-value \
  --secret-id unibudget/supabase/application \
  --secret-string file:///secure/path/application.json
```

Use equivalent commands for the migration secret and the CA PEM, then remove
the temporary files. Do not put secret values in shell history. The deployment
workflow never reads secret values; only the ECS task execution roles do.

### Explicit pooler hostname

Pass the dashboard hostname on every deployment, for example:

```bash
-c supabaseHost=aws-0-eu-central-1.pooler.supabase.com
```

Use the exact project pooler host and region shown in the dashboard. Do not copy
a hostname from another project, another region, or this document. Changing the
host later requires a maintenance deployment: the workflow validates the
migration task's `PGHOST` and refuses to migrate against a stale task
definition.

## TLS

Both containers require verified TLS:

- `PGSSLMODE=verify-full`
- `SUPABASE_CA_CERT` is injected from `unibudget/supabase/ca`

The same PEM can be supplied locally through `PGSSLROOTCERT`. The shared
configuration in `src/lib/postgresConfig.mjs` rejects every mode other than
`verify-full`, requires a PEM CA, and sets `rejectUnauthorized: true`. It does
not support an unverified fallback, and TLS options embedded in a connection
URL are rejected. The driver also verifies that the pooler hostname matches the
certificate; do not connect by IP.

The image does not download or bundle a CA certificate. The certificate is
public material, but it is supplied at runtime so certificate rotation does not
require an image rebuild.

## Migration runner

`scripts/migrate.mjs` is a deliberate one-off operation and is not part of
container startup. It:

- accepts sorted `NN_lower_snake_case.sql` files only and rejects other `.sql`
  names instead of silently ignoring them;
- sets `search_path = public, extensions, pg_temp` so unqualified DDL lands in
  `public` while Supabase's `uuid-ossp` remains resolvable;
- uses a PostgreSQL advisory lock, one transaction per migration, and a
  schema-qualified `public.schema_migrations` ledger;
- performs preflight **read-only**: a rejected run cannot create the ledger,
  add the checksum column, or update existing ledger rows;
- records a SHA-256 checksum for every migration and rejects a ledger entry
  whose file has changed;
- refuses unknown ledger rows, non-contiguous migration history, missing tables
  or columns for already-applied migrations, and UniBudget tables that exist
  before their creating migration;
- grants `unibudget_app` only `CONNECT`, schema `USAGE`, and
  `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `users`, `sessions`, `profiles`,
  `transactions`, and `monthly_budgets`;
- revokes `anon`, `authenticated`, and `service_role` from those tables, the
  legacy category-budget archive, and the `schema_migrations` ledger, without
  changing Supabase-managed objects or global `supabase_admin` defaults;
- commits that Data API revoke **in the same transaction as each migration**,
  so a later failure cannot leave newly created tables readable through the
  Data API;
- verifies every privilege individually (the comma-separated
  `has_table_privilege` form means "any", not "all"), and fails if a Data API
  role retains access or the application role gains access to the ledger or
  legacy archive;
- refuses an application role with elevated attributes, role memberships, or
  public-schema object ownership, and never silently falls back to connecting
  the app as `postgres`;
- bounds connection acquisition at 10 seconds, statements and queries at 120
  seconds, and lock acquisition at 30 seconds;
- exits immediately on `SIGTERM`/`SIGINT`, letting PostgreSQL roll back the
  open transaction and release the session advisory lock when ECS stops a
  cancelled task;
- always releases the advisory lock and pooled client after an ordinary
  failure.

The migration connection needs `CREATEROLE` and, on PostgreSQL 16+, `ADMIN
OPTION` on an existing `unibudget_app` role. Elevated attributes, role
memberships, or public-schema ownership cause a hard failure rather than a
silent fallback to a broader role. A future migration that adds a table must
add it to the runner's application and protected table lists; access is
enumerated deliberately instead of globally revoking grants in `public`.

The runtime image includes the migration SQL, runner, and the shared
PostgreSQL configuration module at the path the runner imports. Only
`scripts/start.mjs` and `scripts/migrate.mjs` are copied into the runtime image;
local diagnostic scripts are excluded by `.dockerignore` and the Dockerfile.

`uuid-ossp` is installed in Supabase's `extensions` schema; inserts using the
UUID column defaults do not require privileges on that schema.

## Health checks, liveness, and role assertion

Two endpoints report different things, and each probe uses the one that
matches its purpose:

| Endpoint | Reaches PostgreSQL | Used by |
| --- | --- | --- |
| `/api/live` | no | ECS container health check and the image `HEALTHCHECK` |
| `/api/health` | yes | ALB target group, the workflow's post-deploy check, and operators |

`/api/live` answers `{"status":"ok"}` with HTTP 200 from the process alone.
It never opens a connection, so a Supabase outage cannot mark a healthy task
as dead and send ECS into a replacement loop.

`/api/health` runs `SELECT 1` on a separate single-connection pool with a
two-second server-side `statement_timeout` and a 2.5-second client query
timeout. The query is cancelled, not merely raced, and returns
`{"status":"ok"}` with HTTP 200 or `{"status":"unavailable"}` with HTTP 503.
It never returns database, host, role, or credential details. Both endpoints
accept only HTTP 200 and neither is cached or protected by the role gate.

In production, middleware asserts that the current database role is
`unibudget_app` and returns 503 if it is not. The check uses the same bounded
health pool, is cached after the first success, and is retried after a failure,
so a misconfigured `PGUSER` fails closed instead of hanging the request or
running with elevated privileges.

The split is deliberate. Readiness stays database-dependent, so the load
balancer stops routing new requests to a target that cannot serve them.
Liveness stays database-independent, so ECS keeps the existing tasks. During
a database outage the observed effect is a drained target group behind
CloudFront that recovers on its own, not a service that replaces its tasks
every few minutes. The trade-off is that ECS will not replace a task whose
process is alive but whose database connection is broken; that task is
reused when the dependency recovers instead of being restarted.

## Observability and alerts

The application writes to `/unibudget/ecs/application` with seven-day
retention. `src/lib/serverLogger.ts` emits one JSON object per line for every
request (`http.request` with `requestId`, `method`, `path`, `status`, and
`durationMs`) and for every server-side failure (`level: "error"` with `event`,
`errorName`, and an optional SQLSTATE `code`). Both record types share a
`requestId`, which is also returned in the `X-Request-Id` header, so a failure
can be traced to the exact request. It never logs credentials, SQL, query
strings, session tokens, or user data. See [logging.md](logging.md) for the
field schema and the alarm-to-log workflow.

The separate `UniBudgetStack-Monitoring` stack has a metric filter for
`{ $.level = "error" }` and four deployed alarms. `UniBudgetStack` no longer
defines any alarm or metric filter; its test asserts that absence, so an
application release cannot recreate the duplicate filter:

| Alarm | Meaning and first diagnostic |
| --- | --- |
| Target 5xx | More than five target 5xx responses in ten minutes; inspect the latest error events and the running digest. |
| Unhealthy targets | A target is failing `/api/health`; check database reachability, role assertion, and task logs. |
| Live tasks | Fewer live tasks than the desired count for three minutes; inspect ECS events, task stop reasons, and capacity. `LiveTaskCount` does not require Container Insights. |
| Structured errors | More than five error log events in ten minutes; query Logs Insights by `level = "error"` and `event`. |

Alarm notifications use the existing SNS topic with a confirmed subscription.
The monitoring stack imports the topic and does not create or subscribe one.
As of 2026-10-25 the stack is `UPDATE_COMPLETE`, the four alarms are `OK`, and
CloudWatch alarm history records a successful SNS action from a manual state
transition. Inbox receipt was not independently verified, and no real metric
threshold crossing has been observed **in production** — one was observed in
the disposable drill account on 2026-10-26 (see the drill record). Do not
deploy the application stack to
add alarms: its earlier monitoring change set is blocked by ECS/ECR coupling
and would recreate resources now owned by the monitoring stack. The exact
topic policy, deployment commands, change-set history, subscription
confirmation, and per-alarm triage steps are in [alarms.md](alarms.md); a
direct SNS publish does not prove that CloudWatch is allowed to publish to the
topic.

## HTTPS and the CloudFront distribution

The public entry point is an Amazon CloudFront distribution in front of the
load balancer. It uses the AWS-generated distribution hostname
(`https://<distribution-id>.cloudfront.net`) and CloudFront's default trusted
certificate, so this deployment deliberately has no custom domain, no DNS
record to create, and no ACM certificate to validate.

The distribution is configured by the CDK stack, not by hand:

- **Viewer protocol:** every request is redirected to HTTPS
  (`redirect-to-https`). The ALB has no certificate and no HTTPS listener.
- **Origin:** the ALB DNS name over HTTP. The ALB security group accepts port
  80 **only** from the `com.amazonaws.global.cloudfront.origin-facing` managed
  prefix list, so plain HTTP cannot reach the application directly. The
  workflow looks up the regional prefix list ID and passes it to the stack.
  The prefix list admits CloudFront origin-facing servers generally, not only
  this distribution; the ALB DNS name is not published, and a secret origin
  header with an ALB listener rule can add per-distribution isolation if
  required.
- **Caching:** `CachingDisabled` for the whole distribution. Astro renders
  per-user HTML, and the same host serves `/api/auth/*`, `/api/budgets`,
  `/api/transactions`, `/api/health`, and `/api/live`; no response may be
  stored or shared between viewers.
- **Origin request policy:** `AllViewer`, which forwards every viewer header
  (including `Host`), all cookies (the `session` cookie), and all query strings.
  Astro therefore sees the CloudFront hostname and its relative redirects stay
  on the public HTTPS origin.
- **Methods:** `GET, HEAD, OPTIONS, PUT, PATCH, POST, DELETE`, because the API
  uses POST, PATCH, PUT, and DELETE.
- **Cookies:** the application sets `HttpOnly; SameSite=Strict; Path=/` and
  adds `Secure` when `NODE_ENV=production` (the ECS task sets it). The cookie is
  host-only for the CloudFront hostname, so it is never sent over plain HTTP and
  never shared with another origin.
- **Client IPs:** CloudFront appends the viewer IP to `X-Forwarded-For`, and
  the ALB is set to `preserve` that header instead of appending the CloudFront
  edge IP, so the application's rightmost-entry parsing and per-client rate
  limiting keep working.

CSRF protection relies on `SameSite=Strict` and the single-origin deployment:
there is no CORS allowance, the browser does not attach the session cookie to
cross-site requests, and authentication redirects are relative paths, so the
viewer stays on the CloudFront HTTPS origin. The deployment workflow verifies
that the distribution is `Deployed`, points at the stack's ALB, redirects HTTP
to HTTPS, disables caching, forwards all headers and cookies, and allows all
required methods **before** the image is built or the migration starts.

CloudFront applies its default viewer security policy to the AWS-managed
certificate. AWS documents that the default `*.cloudfront.net` certificate
automatically sets that policy to `TLSv1`; a modern policy such as
`TLSv1.2_2021` requires a custom SSL certificate, an alternate domain name, and
SNI. That means a custom domain, an ACM certificate in `us-east-1`, and DNS
changes. See [cloudfront-tls-plan.md](cloudfront-tls-plan.md) for the verified
current state, the recommended `TLSv1.2_2021` target, the proposed CDK shape,
and the separate approval/rollback requirements. It is not part of this
deployment and has not been applied.

## First deployment

Creating the stack for the first time is a manual, deliberate operation. The
`Deploy` workflow only updates an existing stack: it fails when `UniBudgetStack`
does not exist, and it has no bootstrap input.

Prerequisites:

- an approved AWS account and region, with the CDK bootstrap stack deployed;
- the repository environment `production` and its OIDC deploy role with the
  EC2 and CloudFront permissions listed below;
- no custom domain, DNS record, or ACM certificate (CloudFront supplies
  HTTPS);
- the three Supabase secrets populated **after** the stack exists;
- a restorable Supabase backup or PITR restore point, recorded before the
  migration run;
- approval to create the retained RDS instance, ALB, CloudFront distribution,
  Fargate service, ECR repository, and CloudWatch log group.

### Creating the stack (one-time)

1. Create the stack without starting the application. Use the real tag you
   will push; the task definitions can reference it before the image exists
   because the desired count is zero.

   ```bash
   cd hello-cdk
   prefix_list_id=$(aws ec2 describe-managed-prefix-lists \
     --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
     --query 'PrefixLists[0].PrefixListId' --output text)
   npx cdk deploy --require-approval never \
     -c imageTag="$IMAGE_TAG" \
     -c desiredCount=0 \
     -c supabaseHost="$SUPABASE_HOST" \
     -c cloudFrontOriginPrefixListId="$prefix_list_id"
   ```

2. Populate the three Supabase secrets.
3. Authenticate to ECR using the `ImageRepositoryUri` stack output, then build
   and push the same tag. Never reuse an existing immutable tag.
4. Run the migration task on the image you just pushed. ECS container
   overrides have no `image` field, so `run-task --overrides` cannot select an
   image; the one-off task has to reference it in a task definition. Register a
   temporary revision from the stack's current migration definition with only
   the image replaced:

   ```bash
   aws ecs describe-task-definition \
     --task-definition "$MIGRATION_TASK_DEFINITION_ARN" \
     --query 'taskDefinition' \
     --output json > /tmp/migration-task.json

   node scripts/migrationTaskDefinition.mjs \
     /tmp/migration-task.json "$IMAGE_URI" > /tmp/migration-registration.json

   one_off_task_definition=$(aws ecs register-task-definition \
     --cli-input-json file:///tmp/migration-registration.json \
     --query 'taskDefinition.taskDefinitionArn' \
     --output text)

   aws ecs run-task \
     --cluster "$CLUSTER_NAME" \
     --task-definition "$one_off_task_definition" \
     --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_IDS],securityGroups=[$SECURITY_GROUP_ID],assignPublicIp=ENABLED}"
   ```

   `scripts/migrationTaskDefinition.mjs` copies the described definition's
   family, roles, CPU and memory, network mode, runtime platform, environment,
   secrets, and logging, and changes nothing except the `MigrationContainer`
   image. It fails if the definition has no `MigrationContainer`, if the image
   reference is empty, contains whitespace, or carries no tag or digest, and it
   never sends the read-only fields that `register-task-definition` rejects. It
   also fails if the described definition has a field it does not know how to
   preserve, instead of silently dropping configuration.

   Confirm the revision before running it:

   ```bash
   aws ecs describe-task-definition \
     --task-definition "$one_off_task_definition" \
     --query "taskDefinition.containerDefinitions[?name=='MigrationContainer'].image" \
     --output text
   ```

   Wait until `describe-tasks` reports `STOPPED`, require every container exit
   code to be `0`, and only then deregister the one-off revision; the service
   never references it:
   `aws ecs deregister-task-definition --task-definition "$one_off_task_definition"`.
   Do not continue to a rollout if the migration fails. Run the migration a
   second time to confirm checksum/idempotency behavior.
5. Deploy again with the same image tag, pooler host, prefix list ID, and the
   approved running count (for example `desiredCount=2`).
6. Verify the `ApplicationUrl` output, `/api/health`, and `/login` over HTTPS,
   then confirm a signed-in session survives a request: the cookie is `Secure;
   HttpOnly; SameSite=Strict`, every request stays on the CloudFront hostname,
   and in Supabase the application role is `unibudget_app` while `anon`,
   `authenticated`, and `service_role` hold no privileges on the UniBudget
   tables or `schema_migrations`.

Once the stack exists, every later release runs through
`.github/workflows/deploy.yml`; the manual steps above are for the first
creation only.

The migration task and the application share one image tag, but the migration
must run before the service rollout. The workflow enforces that ordering.

## GitHub Actions OIDC deployment

`.github/workflows/deploy.yml` is manual (`workflow_dispatch`), uses GitHub
OIDC through `aws-actions/configure-aws-credentials`, and uses no long-lived
AWS access keys. It has `id-token: write` and reads the protected environment
`production`.

Configure these repository or environment variables:

- `AWS_DEPLOY_ROLE_ARN`
- `AWS_REGION`
- `AWS_ACCOUNT_ID`
- `SUPABASE_HOST`

The application workflow does not deploy alarms. `UniBudgetStack-Monitoring` is
deployed separately with its own `alarmTopicArn` context; see
[alarms.md](alarms.md). No `ALARM_TOPIC_ARN` repository variable is required.

The CloudFront hostname and the origin-facing prefix list ID are not repository
variables: the workflow reads the hostname from the stack outputs and looks up
the regional prefix list at deployment time. There is no `APPLICATION_URL` or
`CERTIFICATE_ARN` variable.

The workflow reads the ECR repository URI, cluster, service, both task
definitions, the task-role and execution-role ARNs, the three Supabase secret
ARNs, subnets, security group, load balancer DNS name, CloudFront distribution
ID and domain, and the derived HTTPS application URL from stack outputs. It no longer accepts a repository name, full URI, task
definition, cluster, service, subnet, or security-group variable that could
drift from the deployed stack.

### Trust policy

Create an IAM OIDC identity provider for `token.actions.githubusercontent.com`
if the account does not already have one, then restrict the deploy role to this
repository and the `production` environment:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPOSITORY>:environment:production"
        }
      }
    }
  ]
}
```

Do not use a wildcard `sub` such as `repo:<OWNER>/<REPOSITORY>:*`, and do not
add a branch claim in place of the environment claim. Protect the `production`
environment with required reviewers so the OIDC subject can only be obtained
through an approved deployment.

### AWS roles and least-privilege permissions

Four distinct role types are involved. Do not merge them:

| Role | Assumed by | Responsibilities |
| --- | --- | --- |
| GitHub deploy role | The OIDC provider for the `production` environment | Runs the AWS CLI and CDK, assumes CDK bootstrap roles, passes the CloudFormation execution role, and passes the migration task roles to `ecs:RunTask`. |
| CloudFormation execution role (`cdk-hnb659fds-cfn-exec-role-<ACCOUNT_ID>-<REGION>`) | CloudFormation during `cdk deploy` | Creates and updates stack resources and passes the application and migration task/execution roles to ECS. |
| ECS task roles (`ApplicationTaskTaskRole`, `MigrationTaskTaskRole`) | The container process | Have no AWS permissions in this stack. They are not the roles that read secrets. |
| ECS execution roles (`ApplicationTaskExecutionRole`, `MigrationTaskExecutionRole`) | The ECS agent | Pull the image, write CloudWatch logs, and read only the secrets referenced by that task definition. |

The GitHub deploy role needs these actions for the commands in
`.github/workflows/deploy.yml`:

| Service | Required actions | Scope |
| --- | --- | --- |
| STS | `GetCallerIdentity`; `AssumeRole` for the CDK bootstrap publishing roles | `*` for `GetCallerIdentity`; the CDK bootstrap roles for `AssumeRole` |
| EC2 | `DescribeManagedPrefixLists` | The CloudFront origin-facing managed prefix list in the deployment region |
| CloudFront | `CreateDistribution`, `GetDistribution`, `GetDistributionConfig`, `UpdateDistribution`, `DeleteDistribution`, `ListDistributions`, `TagResource`, `ListTagsForResource` | The `UniBudgetStack` distribution |
| CloudFormation | `CreateStack`, `UpdateStack`, `DescribeStacks`, `DescribeStackEvents`, `DescribeStackResources`, `ListStackResources`, `GetTemplate`, `GetTemplateSummary`, `CreateChangeSet`, `DescribeChangeSet`, `ExecuteChangeSet`, `DeleteChangeSet` | The `UniBudgetStack` stack |
| ECR | `GetAuthorizationToken` | `*` |
| ECR | `DescribeImages`, `BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage` | The `UniBudgetStack` repository |
| ECS | `DescribeClusters`, `DescribeServices`, `DescribeTaskDefinition`, `DescribeTasks`, `RunTask`, `StopTask`, `RegisterTaskDefinition`, `DeregisterTaskDefinition` | The `UniBudgetStack` cluster and service, plus the `UniBudgetStack` task definition families for the task-definition actions |
| IAM | `GetRole`, `PassRole` | The stack roles listed below; do not use `*` |
| S3 / SSM | Read/write the CDK bootstrap bucket and read its version parameter | The CDK bootstrap resources |

`ecs:DescribeTaskDefinition` is required by the workflow's validation of **both**
task definitions, and by the migration step's read-back of the one-off
revision; it is not optional. `ecs:RegisterTaskDefinition` and
`ecs:DeregisterTaskDefinition` are required because the migration runs on a
temporary revision that pins the newly built image; ECS has no image
override, so without those two actions the migration step fails before
`RunTask`. Scope them to the migration task definition family. Registering
the revision also passes the task and execution roles, so the `iam:PassRole`
entry above must include both migration roles. `ec2:DescribeManagedPrefixLists` is
required because the workflow resolves the CloudFront origin-facing prefix list
and passes its ID to the stack. `cloudfront:GetDistribution` and
`cloudfront:GetDistributionConfig` read the deployed distribution back, and
`cloudfront:CreateDistribution` / `cloudfront:UpdateDistribution` are exercised
by CDK when the stack creates or changes it. The default CDK bootstrap
CloudFormation execution role already has broad permissions; a custom execution
role needs the CloudFront and EC2 actions as well.

The workflow does not call Secrets Manager at all: the secret ARNs are copied
from stack outputs and compared to the task definitions. Secret **values** are
read only by the ECS execution roles when a task starts.

The GitHub deploy role's `iam:PassRole` is limited to the roles it passes
directly:

- `MigrationTaskTaskRole` and `MigrationTaskExecutionRole`, because the
  workflow calls `ecs:RunTask` for the migration task;
- the CDK bootstrap CloudFormation execution role, because CDK passes it to
  CloudFormation.

It does **not** need `iam:PassRole` for `ApplicationTaskTaskRole` or
`ApplicationTaskExecutionRole`: the workflow never calls `ecs:RunTask` for the
application task. CloudFormation does when it creates or updates the ECS
service. A custom CloudFormation execution role therefore needs `iam:PassRole`
for all four ECS role ARNs, plus the role-management actions
(`CreateRole`, `GetRole`, `PutRolePolicy`, `AttachRolePolicy`,
`DetachRolePolicy`, `DeleteRolePolicy`) used to create and update the stack's
roles. The default CDK bootstrap execution role has broad permissions; scope it
if your bootstrap uses a custom policy.

The stack exports the exact ARNs needed for these policies:

```bash
aws cloudformation describe-stacks \
  --stack-name UniBudgetStack \
  --query 'Stacks[0].Outputs' \
  --output table
```

Copy `ApplicationTaskRoleArn`, `ApplicationTaskExecutionRoleArn`,
`MigrationTaskRoleArn`, and `MigrationTaskExecutionRoleArn` from that output.
They are also the values written into both ECS task definitions.

| Stack output ARN | Task | GitHub deploy role `PassRole` | CloudFormation execution role `PassRole` |
| --- | --- | --- | --- |
| `ApplicationTaskRoleArn` | Application task process | No; the workflow does not run this task | Yes, when creating/updating the service |
| `ApplicationTaskExecutionRoleArn` | Application ECS agent | No; the workflow does not run this task | Yes, when creating/updating the service |
| `MigrationTaskRoleArn` | Migration task process | Yes, for `ecs:RunTask` | Yes, when creating/updating the task definition |
| `MigrationTaskExecutionRoleArn` | Migration ECS agent | Yes, for `ecs:RunTask` | Yes, when creating/updating the task definition |

Scope `iam:PassRole` to those exact four ARNs as appropriate for the role doing
the passing; do not grant `iam:PassRole` on `*`. Re-read the outputs after any
stack replacement, because the auto-generated role ARNs change when a role is
replaced.

The GitHub deploy role's migration `PassRole` policy must use the exact
migration ARNs and the ECS service principal:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PassMigrationRolesToEcs",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "<MIGRATION_TASK_ROLE_ARN>",
        "<MIGRATION_TASK_EXECUTION_ROLE_ARN>"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "ecs-tasks.amazonaws.com"
        }
      }
    },
    {
      "Sid": "PassCloudFormationExecutionRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-cfn-exec-role-<ACCOUNT_ID>-<REGION>"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "cloudformation.amazonaws.com"
        }
      }
    }
  ]
}
```

A custom CloudFormation execution role's ECS `PassRole` statement must use the
same exact four ARNs, not a wildcard:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PassEcsTaskRoles",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "<APPLICATION_TASK_ROLE_ARN>",
        "<APPLICATION_TASK_EXECUTION_ROLE_ARN>",
        "<MIGRATION_TASK_ROLE_ARN>",
        "<MIGRATION_TASK_EXECUTION_ROLE_ARN>"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "ecs-tasks.amazonaws.com"
        }
      }
    }
  ]
}
```

Do not add `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` to GitHub. The OIDC
trust policy and the `production` environment approval are the authorization
boundary.

The role `unibudget-github-deploy` was verified on 2026-10-25 to still have the
AWS-managed `AdministratorAccess` policy. Its trust policy is restricted to
this repository and the `production` environment, but least privilege has not
been applied. See [iam-least-privilege.md](iam-least-privilege.md) for the
verified inventory and the staged migration plan.

## Release versions, image identity, and provenance

The next release candidate is **`v1.1.0`**: the changes fix the blog route and
add operational hardening without a breaking API or schema change. Do not
automatically use `v2.0.0`. The existing `v1.0.0` Git tag is not moved; the
deployed `v1` image is a legacy artifact whose exact source commit cannot be
proven because it predates the OCI labels.

- `imageTag` must be `vMAJOR.MINOR.PATCH` with an optional prerelease suffix.
  The workflow rejects `v1`, `latest`, branch names, and commit SHAs before it
  builds anything. A normal deployment also requires an annotated Git tag with
  exactly that name on `GITHUB_SHA`; dispatch the workflow from the tagged
  commit (normally `main` after the tag is pushed).
- The ECR tag is immutable; the digest is the content identity. The workflow
  records the digest and verifies the running ECS task's `imageDigest`.
- The image carries `org.opencontainers.image.version` and
  `org.opencontainers.image.revision`; the revision is `GITHUB_SHA`.
- The ECR lifecycle policy retains ten tagged and ten untagged manifests. Do
  not add a second SHA tag per release; it would consume the retention window.

No `v1.1.0` tag or image has been created. See
[release-readiness.md](release-readiness.md) for the exact release sequence.

## Subsequent deployments

For an existing stack the workflow installs the dependencies, runs the
application test suite (a failure stops the run before any image or AWS change),
and then:

1. requires the `imageTag` input to be a semantic release version
   (`vMAJOR.MINOR.PATCH`, optional prerelease), requires the same annotated
   Git tag to point at `GITHUB_SHA`, and verifies the live ECR lifecycle policy
   is release-safe (ten tagged, ten untagged, no `any` rule); a missing or
   mismatched tag or an unsafe policy stops the run before any image is built
   or pushed. The tag check runs on every deployment, because every run
   publishes an image;
2. reads `ApplicationUrl`, `CloudFrontDomainName`, and
   `CloudFrontDistributionId` from the stack outputs and verifies that the
   distribution is `Deployed`, serves this stack's ALB, redirects HTTP to
   HTTPS, uses `CachingDisabled`, forwards all headers and cookies, allows the
   required methods, and is not attached to a custom domain, then requests the
   HTTPS `/login` page through CloudFront and requires the real UniBudget login
   form on a cache miss, following redirects only on that hostname, before
   building or migrating. It also verifies that the `Request5xx` deployment
   alarm exists, measures `UniBudget/Application` `Http5xxCount`, and has alarm
   actions enabled, so a missing monitoring stack stops the run before the
   image build or the migration;
3. builds and pushes a new immutable tag (it refuses to overwrite an existing
   tag), validates the returned `sha256:` digest, records it in the run output,
   and writes the digest to the job summary;
4. reads both task definitions and the exact role and secret ARNs from stack
   outputs;
5. verifies the cluster and service are `ACTIVE`;
6. verifies both task definitions' task role and execution role ARNs against
   the stack outputs, the application container's exact environment variables
   and secret references, and the migration container command, `PGHOST`,
   `PGPORT`, `PGDATABASE`, `PGSSLMODE`, and exact secret names and ARNs;
7. registers a one-off revision of the migration task definition whose only
   change is the image this run built, verifies that revision's
   `MigrationContainer` image, and runs it. It waits up to 30 minutes; if that
   expires it stops the task and waits up to two more minutes for ECS to report
   `STOPPED`. The one-off revision is deregistered only after that confirmation,
   or after a task that failed on its own had already stopped. On cancellation,
   or when the stop cannot be confirmed, the task is stopped but the revision is
   left registered for inspection. The ECS service is never scaled down or
   pointed at the temporary revision, and the rollout still uses `$IMAGE_TAG`
   from the same build;
8. deploys the stack only after migration exit code `0`, passing
   `-c deploymentAlarmName=<alarm>` so the ECS service watches that alarm for
   the rollout;
9. waits for ECS service stability, verifies that the service's deployment
   configuration still lists the alarm with rollback enabled, that the task
   definition references the built image tag, and that a running task reports
   the recorded image digest, then checks `/api/health`, `/login`, one real
   `/blog/<slug>` entry
   from `src/content/blog`, and an unknown blog slug through the CloudFront
   HTTPS URL. The blog checks exist because health and login can be green while
   a dynamic content route still fails or returns its not-found page as 200.

The workflow requires an explicit `desiredCount` between `1` and `10`; it has
no default and never silently scales the service to zero. A run also requires
`recoveryPlanVerified=true`, the explicit confirmation that a
restorable Supabase backup or PITR restore point exists, plus that point's
`recoveryPointReference` and `recoveryPointTimestamp`, which are recorded in the
run summary; the run refuses to migrate without them. To intentionally stop the
service, deploy the stack
separately with `desiredCount=0` during an approved maintenance window.

If the pooler host or secret references in the stack differ from what the
workflow expects, validation fails **before** the migration. Do not bypass the
check by overriding task environment values.

### Deployment alarm and stack order

Any deployment that starts tasks must name an alarm, because that alarm is what
rolls a bad rollout back. The order is fixed and cannot be inverted:

1. `UniBudgetStack` must exist first — `UniBudgetStack-Monitoring` imports its
   log group, target group, and SNS topic.
2. Deploy `UniBudgetStack-Monitoring`, which creates `Request5xx` and the
   `status >= 500` metric filter (see [alarms.md](alarms.md)).
3. Deploy the application stack with
   `-c deploymentAlarmName=UniBudgetStack-Monitoring-Request5xx`. The CDK entry
   point refuses `desiredCount > 0` without it, and ECS fails a stack update
   that names an alarm which does not exist.

```bash
cd hello-cdk
npx cdk deploy UniBudgetStack --require-approval never \
  -c imageTag="$IMAGE_TAG" \
  -c desiredCount=1 \
  -c deploymentAlarmName=UniBudgetStack-Monitoring-Request5xx \
  -c supabaseHost="$SUPABASE_HOST" \
  -c cloudFrontOriginPrefixListId="$prefix_list_id"
```

A stack update that starts no tasks (`desiredCount=0`) does not need the alarm,
and neither does destroying the stack when `desiredCount` is left at its
default of `0`. Every update that starts tasks does need it.

Changing the pooler host needs a maintenance deployment: deploy the stack with
`desiredCount=0` so the application is not restarted against the old host,
confirm the new migration task definition, run the migration on a one-off revision
pinned to the image you pushed, then deploy the approved running count. Schedule the window and
confirm the new pooler host and credentials in a disposable environment first.

### Upgrading an existing UniBudgetStack

A stack created before this revision may be running, may have an outdated
`ApplicationUrl`, and may lack the task-role, execution-role, and secret-ARN
outputs that the workflow now validates. This revision also adds the CloudFront
distribution and the prefix-list-only ALB ingress, and removes the ACM
certificate and custom-domain inputs. Perform this one-time upgrade with
`desiredCount=0` in a maintenance window (creating the stack is a separate
manual step; the workflow only updates an existing stack). It updates CloudFormation only; it
does not deploy an image, run a migration, or touch the separate static
S3/CloudFront site.

1. Record the current outputs and RDS physical identity without printing secret
   values. The outputs contain ARNs, not secret contents.

   ```bash
   aws cloudformation describe-stacks --stack-name UniBudgetStack \
     --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs}' \
     --output json
   aws cloudformation describe-stack-resources --stack-name UniBudgetStack \
     --query "StackResources[?ResourceType=='AWS::RDS::DBInstance'].{LogicalId:LogicalResourceId,PhysicalId:PhysicalResourceId,Status:ResourceStatus}" \
     --output table
   ```

   Save the RDS physical ID. Require the same ID after the upgrade.

2. Confirm the CDK app contains only the intended stack. The app refuses to
   build without an image tag and a Supabase pooler hostname, so pass the
   placeholder values below; both only have to be syntactically valid for a
   listing, and neither is used to contact anything:

   ```bash
   cd hello-cdk
   npx cdk ls \
     -c imageTag="example-image-tag" \
     -c supabaseHost="aws-0-example-1.pooler.supabase.com" \
     -c cloudFrontOriginPrefixListId="pl-0123456789abcdef0"
   ```

   `supabaseHost` is the Supabase session-pooler hostname copied from the
   project's Database Settings: a bare DNS name with no scheme, port, path, or
   credentials. Expect only `UniBudgetStack`. If an S3/CloudFront stack
   appears, stop: this deployment must not include or alter the separate static
   site.

3. Synthesize and review the proposed change before deploying. Use the image
   tag the next workflow will build, the pooler host, and the region's
   CloudFront origin-facing prefix list. `desiredCount=0` keeps the application
   stopped during the maintenance window.

   ```bash
   prefix_list_id=$(aws ec2 describe-managed-prefix-lists \
     --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
     --query 'PrefixLists[0].PrefixListId' --output text)
   npx cdk synth UniBudgetStack \
     -c imageTag="$IMAGE_TAG" \
     -c desiredCount=0 \
     -c supabaseHost="$SUPABASE_HOST" \
     -c cloudFrontOriginPrefixListId="$prefix_list_id"
   npx cdk diff UniBudgetStack \
     -c imageTag="$IMAGE_TAG" \
     -c desiredCount=0 \
     -c supabaseHost="$SUPABASE_HOST" \
     -c cloudFrontOriginPrefixListId="$prefix_list_id"
   ```

   Inspect `hello-cdk/cdk.out/UniBudgetStack.template.json` and the diff. The
   diff may show this stack's own `AWS::CloudFront::Distribution`, the ALB
   `routing.http.xff_header_processing.mode` attribute, the new CloudFront
   outputs, and the intended task-definition/role changes. It must not show an
   update or replacement of `AWS::RDS::DBInstance` and must not show
   `AWS::S3::Bucket` or any resource from a separate static-site stack. If it
   does, stop and review the stack/context before doing anything else.
   `cdk diff` is read-only; do not use `cdk deploy` until the RDS and
   static-site scope is confirmed.

4. Apply the one-time stack update. This is a maintenance action: it stops the
   application while the output/role/task-definition changes are applied.

   ```bash
   npx cdk deploy UniBudgetStack --require-approval never \
     -c imageTag="$IMAGE_TAG" \
     -c desiredCount=0 \
     -c supabaseHost="$SUPABASE_HOST" \
     -c cloudFrontOriginPrefixListId="$prefix_list_id"
   ```

   Do not run `cdk destroy`.

5. Verify the new outputs and the retained RDS resource. The RDS physical ID
   must match step 1, and `DeletionProtection` must remain enabled.

   ```bash
   aws cloudformation describe-stacks --stack-name UniBudgetStack \
     --query 'Stacks[0].Outputs' --output table
   aws cloudformation describe-stack-resources --stack-name UniBudgetStack \
     --query "StackResources[?ResourceType=='AWS::RDS::DBInstance'].{LogicalId:LogicalResourceId,PhysicalId:PhysicalResourceId,Status:ResourceStatus}" \
     --output table
   ```

   Require `ApplicationTaskRoleArn`, `ApplicationTaskExecutionRoleArn`,
   `MigrationTaskRoleArn`, `MigrationTaskExecutionRoleArn`,
   `SupabaseApplicationSecretArn`, `SupabaseMigrationSecretArn`,
   `SupabaseCaSecretArn`, `ApplicationUrl`, `CloudFrontDistributionId`, and
   `CloudFrontDomainName` to be present. These are ARNs and a hostname, not
   secret values.

6. `ApplicationUrl` is now the CloudFront HTTPS origin; no DNS record is
   created or updated. Run the normal workflow with the same image tag, the
   approved `desiredCount` (1-10), and `recoveryPlanVerified=true`. It will
   verify the CloudFront delivery configuration, build and push, verify the
   exact roles/secrets before migration, migrate, roll out, and check
   `/api/health` through CloudFront.

The upgrade must not create, replace, or delete the RDS instance, its data, or
the separate static S3/CloudFront deployment. If the diff or CloudFormation
events show any of those changes, stop and investigate instead of continuing.

## Secret rotation

### Application password

The migration runner resets the `unibudget_app` role password to the
`password` field in `unibudget/supabase/application` on every run, so the
database and the secret must be rotated together:

1. Schedule a maintenance window; existing tasks continue using the old
   password until the role is changed.
2. Update the `password` field in `unibudget/supabase/application`.
3. Run the migration task (or the full deployment workflow). If it fails, the
   role still has the old password; restore the old secret value before
   retrying.
4. Force a new ECS deployment after the migration succeeds so tasks read the
   new secret. Expect a brief interruption between the role-password change and
   healthy new tasks.
5. Confirm `/api/health` and a sign-in.

Do not rotate only the secret or only the database role. An image rollback
alone is not sufficient if the role password changed; the previous image also
needs the previous password value.

### Migration password

Rotate the `postgres.<project-ref>` password in Supabase and update the
`password` field in `unibudget/supabase/migration`. The application is not
affected. Run the migration or deployment workflow afterward to confirm the
new credential works.

### CA certificate

Supabase publishes the current CA. Update `unibudget/supabase/ca` with the new
PEM and force a new deployment before the old CA expires. Both tasks read the
certificate at startup, so a running task keeps the certificate it started
with. Never disable verification during rotation.

## Local validation

From the repository root:

```bash
npm ci
npm run check
npm run lint
npm test -- --run
npm run build
docker build -f dockerfile -t unibudget:ssr .
docker run --rm -p 8080:8080 \
  --env-file .env \
  -v "$PWD/certs/supabase-ca.crt:/run/certs/supabase-ca.crt:ro" \
  -e PGSSLROOTCERT=/run/certs/supabase-ca.crt \
  unibudget:ssr
```

The local `.env` provides the application credentials; the mounted CA is the
Supabase certificate downloaded from the dashboard and saved as
`certs/supabase-ca.crt`. The container needs a reachable database to serve
database-backed routes and to pass `/api/health`; use a disposable test
database, never production.

The application reads only runtime `process.env`. In development it loads
`.env` into `process.env` with Node's `process.loadEnvFile()`; production
builds do not inline `import.meta.env.DATABASE_URL` or any other local
credential into the server bundle.

To run migrations locally, load `.env` explicitly because the Node script does
not read it automatically:

```bash
node --env-file=.env scripts/migrate.mjs
```

## Disposable PostgreSQL integration tests

The integration suites only accept the `unibudget_test` database on a loopback
host or the CI `postgres` service. They must never point at Supabase or a shared
database.

- `BUDGET_TEST_DATABASE_URL` enables the budget persistence suite, which uses a
  randomized schema.
- `MIGRATION_TEST_DATABASE_URL` (or `BUDGET_TEST_DATABASE_URL`) enables the
  migration suite, which creates and drops temporary databases and roles. It
  verifies least-privilege app access, Data API revocation including the
  ledger, checksums, idempotent reruns, non-mutating preflight, and that a
  failed later migration cannot leave committed tables exposed.

In CI both variables point at the PostgreSQL 16 service. The suites throw
rather than skip in CI; locally they skip when the variables are absent.

For a local container:

```bash
docker run --rm -d --name unibudget-test-postgres \
  -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=unibudget_test_admin \
  -e POSTGRES_PASSWORD=<test-only-password> \
  -e POSTGRES_DB=unibudget_test \
  postgres:16-bookworm
BUDGET_TEST_DATABASE_URL=postgresql://unibudget_test_admin:<test-only-password>@127.0.0.1:5432/unibudget_test \
MIGRATION_TEST_DATABASE_URL=postgresql://unibudget_test_admin:<test-only-password>@127.0.0.1:5432/unibudget_test \
npm test -- --run
```

## Existing database adoption and restore points

Do not point this runner at an existing database as if it were fresh. It
refuses UniBudget tables without a migration ledger, but a ledger alone is not
proof that the live schema matches: checksums only detect changes made after a
migration was recorded, not a manually baselined database.

Before adopting existing data or running the first production migration:

1. Enable and verify Supabase backups or point-in-time recovery.
2. Record a restore point immediately before the migration and keep its
   timestamp and project reference.
3. Restore that point into a disposable Supabase branch/project and verify the
   restore completes with the expected schema and row counts.
4. Compare the live schema and data with every migration, inspect the legacy
   category-budget archive, and write a reviewed baseline and data-transfer
   plan.
5. Reconcile row counts and financial totals after the migration.

Recovery is a restore of the whole database, not a reverse SQL script. A
restore also rolls back the migration ledger and any application data written
after the restore point; communicate that data-loss window before proceeding.

## Rollback and its limits

- **Application:** the `Request5xx` ECS deployment alarm rolls back a failed
  service deployment; the circuit breaker stays enabled but needs three failed
  launches at `desiredCount: 1`, which is too slow to be the rollback path.
  Both were drilled on 2026-10-26 ([rollback-drill-2.md](rollback-drill-2.md)).
  The ECR lifecycle policy keeps the ten most recent
  tagged releases, and each push adds a tagged OCI index plus untagged
  platform and attestation manifests; the policy counts those separately.
  ECR will not expire an untagged child while a tagged index references it,
  so a retained tag's manifest and attestation survive until that index is
  expired. The window is still finite: confirm the target tag is present with
  `aws ecr describe-images` before relying on it. If the application password
  changed, redeploying the old image also requires restoring the matching old
  password value or rotating the role again.
- **Database:** migrations are forward-only; there are no down scripts.
  Recovery is a Supabase backup or point-in-time restore to a recorded point.
  Restoring the database does not restore the ECR image or ECS task definition;
  coordinate both.
- **Stack:** do not use `cdk destroy`. The retained RDS instance, ECR
  repository, log group, and secrets have retention policies and may outlive
  the application stack.
- **RDS:** decommissioning requires a verified snapshot, an explicit cost
  decision, and a plan for its security group.

Rollback Drill 2 was **executed twice on 2026-10-26** in disposable account
`293633790894`: run 1 required a manual rollback, and run 2 — after the
`Request5xx` deployment alarm was added — rolled back automatically and reached
steady state on the baseline 3 m 10 s after the broken revision was applied
(the alarm itself fired 33 s after the first failed probe). Production has not
been through a drill, and the fixes are not deployed there yet. The record is in [rollback-drill-2.md](rollback-drill-2.md). Do not
use the production account to create an intentional outage.

**Production deployment decision (2026-10-26): not performed.** Getting the
protection into production needs two writes, in this order: deploy
`UniBudgetStack-Monitoring` so `Request5xx` and its metric filter exist, then
release the application so the service is updated with
`-c deploymentAlarmName=UniBudgetStack-Monitoring-Request5xx`. Neither was done
in this pass. The fix lives on `chore/monitoring-alarm-identity`, which is 31
commits behind `origin/main` and not merged, so a release dispatched from
`main` would not contain it, while releasing this branch first needs a merge and
a new tag; the monitoring stack must be deployed from the same reviewed code.
Until both steps run, production keeps four alarms, one metric filter, and a
service with no deployment alarm, and the defence documents say so.

The ECR lifecycle policy in `hello-cdk/lib/cdk-stack.ts` keeps ten tagged
images and ten untagged images. On 2026-10-25 the live repository still used
one `tagStatus: any` rule with `countNumber: 5`, which counted the tagged
index, the amd64 manifest, and the BuildKit attestation together. That policy
was unsafe for the next push because two releases already produce six
manifests.

The authorized correction was applied through the ECR API on 2026-10-25, not
through CloudFormation. The live policy is now tagged `*`/10 plus untagged/10,
the local preflight returns `safe: true`, and a lifecycle preview reports 0
expiring images with all three existing manifests retained. The ECR read-back
matches the policy generated from the merged CDK code byte-for-byte.

The applied policy is:

```json
{"rules":[{"rulePriority":1,"description":"Retain the ten most recent tagged releases as rollback candidates.","selection":{"tagStatus":"tagged","tagPatternList":["*"],"countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}},{"rulePriority":2,"description":"Expire untagged manifests and attestations no longer referenced by a tagged release.","selection":{"tagStatus":"untagged","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}
```

CloudFormation has not reconciled the change: the deployed stack template still
records the old policy. Run `cdk diff` before the next stack deployment and
expect a pending repository update. The deployment workflow's read-only
preflight remains in place and fails before the build if the live policy ever
becomes unsafe again.

A lifecycle preview reflects only the policy currently applied; ECR has no
dry run for an unapplied policy. Re-run the preview after any later policy
change and confirm the tagged release history is retained.

Rollback for the policy change is an explicit ECR write. Use it only if the
ten/ten policy unexpectedly expires a needed manifest; restoring the audited
policy is known but unsafe for long-term retention, so fix forward afterward.

```bash
aws ecr put-lifecycle-policy \
  --repository-name unibudgetstack-applicationrepository13e54097-nb3o4t9o4cok \
  --region us-east-1 \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},"action":{"type":"expire"}}]}'
```

Then run `aws ecr get-lifecycle-policy` and the local `assessLifecyclePolicy`
check. The restored policy is expected to fail that check until the safe policy
is reapplied. No rollback was needed for the 2026-10-25 change; the preview
reported zero expiring images before and after.

## Costs and retained resources

The retained RDS instance, its generated secrets, the ECR repository, and the
log group continue to incur charges after the Supabase cutover. Do not remove
RDS from the stack until a snapshot has been verified and the retention and
billing decision is approved.

An AWS account on the Free plan rejects any RDS backup retention period above
one day. The stack requests exactly one day, the largest value that plan accepts
while keeping automated backups enabled (zero would disable them). Raise it back
to seven days after upgrading to a Paid plan.

Other recurring charges include the ALB, CloudFront requests and data transfer,
Fargate tasks, public IPv4 addresses, ECR storage and scanning, CloudWatch log
ingestion, and Secrets Manager. There is no ACM charge because this deployment
uses CloudFront's AWS-managed certificate. The RDS instance is the largest avoidable cost and remains a risk
until it is deliberately decommissioned.
