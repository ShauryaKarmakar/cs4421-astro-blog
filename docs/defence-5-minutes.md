# UniBudget — five-minute defence brief

**Private rehearsal document — not part of the assessed artifact.**

Baseline: `origin/main` at `02438b4` (26 Oct 2026), which includes PRs #1–#54.
The local checkout is on `chore/monitoring-alarm-identity`, 31 commits behind
`origin/main`, so a few evidence files below (`docs/final-sdlc-report.md`,
`docs/backup-and-recovery.md`, `.github/workflows/backup-database.yml`) exist on
`origin/main` but not in this working tree. Switch to `main` and fast-forward to
`origin/main` if you want to open them live.

**Post-brief update (2026-10-26, second revision):** Rollback Drill 2 was
executed twice in isolated account `293633790894`. Run 1 was a **partial pass**:
detection, traffic isolation and manual recovery worked, but no alarm fired and
the rollout did not roll back automatically. Run 2, after adding a
`status >= 500` metric filter and an ECS deployment alarm, **passed every
criterion except verified notification delivery** — the alarm entered `ALARM`
33 s after the first failed probe and ECS rolled back automatically in 3 m 10 s.

That fix is now **deployed to production** (2026-10-26):
`UniBudgetStack-Monitoring` owns the fifth alarm, `Request5xx` (`> 0` in one
minute), and `UniBudgetStack` was deployed afterwards with the service watching
it, verified by reading `deploymentConfiguration.alarms` back from the service.
Two limits remain and must be said: the production alarm has not yet stopped a
failed production rollout (it is deployed and evaluating, not exercised), and no
one has confirmed that an alarm email arrived. Records:
[rollback-drill-2.md](rollback-drill-2.md) §7–§8,
[rollback-drill-2-result.md](rollback-drill-2-result.md) and
[monitoring-deployment-plan.md](monitoring-deployment-plan.md).

This brief is written as something you can actually say, not just read. The
script is timed. Everything after it is backup material for questions.

---

## 1. The five-minute script

Target: about 650 spoken words, roughly 135 words per minute. Timings are
cumulative. The timings already leave room for pauses; do not race the script.

### 0:00–0:20 — The thesis

> I built UniBudget: a server-rendered Astro budgeting app with a public blog.
> The blog is content. The app has accounts, sessions and per-user money data.
> That one requirement — request-time identity and data — is why this is not a
> static site, and it runs through every branch.

### 0:20–1:35 — What the branches did, in four phases

> **Phase one was the database-foundation and authentication branches:** the
> Postgres schema and a migration runner with checksums and an advisory lock;
> then bcrypt hashing, hashed session tokens, the auth API and route protection.
> The rule I enforced: the user ID comes from the session, never from the request
> body.
>
> **Phase two was the AWS SSR deployment branch:** a containerised Astro Node
> server on ECS Fargate, behind an ALB and CloudFront, with Supabase over
> verified TLS and a separate migration task.
>
> **Phase three was the SRE, hardening, request-logging and monitoring-ownership
> branches:** liveness split from readiness, migration-before-rollout with a 5xx
> deployment alarm that rolls a bad rollout back automatically, immutable
> semantic image tags, structured logs with request correlation, and one
> monitoring stack that owns every alarm.
>
> **Phase four was the static-blog, release-closeout and scheduled-backup
> branches:** an independent static blog on S3 and CloudFront, build and live
> verification, a deploy gate that requires request correlation, and a verified
> daily database backup.
>
> The fix branches are the defects the gates caught; the docs branches record
> the verified release and backup.

### 1:35–2:50 — Four architecture decisions and what I rejected

> **First, SSR instead of static:** the dashboard needs a session and a per-user
> query on every request. The blog became static later, but as a separate
> artifact — different workload, different failure domain.
>
> **Second, CloudFront to ALB to ECS Fargate to Supabase.** CloudFront gives
> HTTPS with an AWS-managed certificate because I do not own a domain. The ALB is
> HTTP and accepts only CloudFront's origin-facing prefix list, so you cannot
> bypass HTTPS. Fargate gives a repeatable container; Supabase gives managed
> Postgres without running RDS.
>
> **Third, two health checks.** `/api/live` never touches the database;
> `/api/health` does a bounded query. If the database fails, ECS must not kill
> healthy tasks — the load balancer drains them instead. One endpoint for both
> would cause a restart loop during a database outage.
>
> **Fourth, rollout and recovery:** rolling deployment that watches a 5xx
> deployment alarm, with the circuit breaker as a backstop, migrations before the
> new tasks, and immutable semantic tags verified by digest. I chose rolling
> over blue/green because a second target group, CodeDeploy and traffic switching
> is complexity this single service does not need. It is a trade-off, not zero
> downtime.

### 2:50–3:35 — What went wrong, and why that is the strongest evidence

> Three releases failed before v1.1.3, and none pushed an image. v1.1.0 had no
> Postgres service in the deploy test gate; v1.1.1 hit a `57P01` teardown race;
> v1.1.2 counted the keys of an object instead of reading `Origins.Items` from
> CloudFront. I fixed each cause in its own branch, kept the failed tags for
> audit, and v1.1.3 passed every gate. I also found duplicate alarm ownership
> and made the monitoring stack the sole owner, with a test that fails if alarms
> return.

### 3:35–4:50 — Limits and close

> What is not done: the deploy role still has `AdministratorAccess`; ADR 0010 is
> a proposed least-privilege plan, not an applied one. CloudFront's viewer TLS
> minimum is TLSv1. I ran Rollback Drill 2 twice in an isolated account: the
> first run exposed that no alarm could see a failed rollout, so I added a 5xx
> access-record alarm and made ECS watch it; the second run rolled back
> automatically in about three minutes with no operator action. Both halves of
> that fix are now deployed to production, so the service watches the alarm; it
> has not yet stopped a failed production rollout, and alarm email receipt is
> still unconfirmed.
> RPO and RTO are not agreed; Supabase Free has no point-in-time recovery, so the
> daily dump is the recovery point. The rate limiter is per-process. And the
> service is one task at 0.25 vCPU / 512 MiB, not highly available.
>
> So the honest summary: I can show what is deployed, what is tested, and what is
> still a gap. I do not claim the last group is finished.

**If you are running long, cut:** the detail in phase one, the branch-name
lists (keep the outcomes), and the third sentence of the rollout paragraph. Do
not cut the limits — that is what separates a defence from a sales pitch.

---

## 2. Branch map — what each branch was for

One branch per risk or deliverable, merged through a PR. Most branches are now
fully contained in `origin/main`; that is why their names still exist locally
without unique commits. Do not present stale branch names as separate work.

### Phase 1 — Content, tooling, foundation

| Branch / PR | What it changed | Why it exists |
| --- | --- | --- |
| `1-author-biography-on-blog-posts` (#2) | Author collection, bio on posts | Blog needed real authorship, not placeholder copy. |
| `3-add-zod-frontmatter` (#4) | Zod schemas for blog and author frontmatter | Catch malformed content at build time, not in production. |
| `add-tests` (#29) | Vitest setup and the first unit suites | Establish a test baseline before adding a database and a deployment. |
| `add-cdk` (merged, then reverted by #27) | First CDK and CI attempt | It was not reliable yet; reverting was safer than defending a half-working pipeline. Rebuilt properly later. |
| `dependabot-auto-merge` (#28) | Weekly grouped dependency updates and auto-merge | Keep dependencies current without hand-managing every patch. |
| `feature/database-foundation` (merge `53daafa`) | Initial schema (`migrations/01`), `pg` pool, bcrypt/session helpers, role model | The app needed durable users and sessions before auth could be real. |
| `feature/authentication` (#36) | UniBudget SSR app, `migrations/02`–`04` (transactions, budgets), auth API, rate limiting, protected routes | Turn the blog shell into the actual product. |

### Phase 2 — Runtime and delivery

| Branch / PR | What it changed | Why it exists |
| --- | --- | --- |
| `feat/aws-ssr-deployment` (#37) | Dockerfile, ECS/Fargate, ALB, CloudFront, Supabase secrets, migration task, readiness endpoint | Get the server off the laptop with a repeatable, immutable artifact. |
| `feat/aws-load-balancer-deployment` | Earlier name for the hardening work that merged through #39 | Same work, renamed mid-stream; do not count it as a second deliverable. |
| `feat/week-7-sre-rollback` (#39) | Separate liveness/readiness, deploy gates, rollback readiness | The first deploy proved the runtime; this phase made it operable. |
| `feat/final-project-hardening` (#40) | Production hardening, ECR lifecycle policy and preflight, rollback evidence | Close the gap between “it deployed” and “it is release-ready”. |

### Phase 3 — Observability and release safety

| Branch / PR | What it changed | Why it exists |
| --- | --- | --- |
| `feat/request-logging` (#41) | JSON access records, `AsyncLocalStorage` correlation, `X-Request-Id` response header | A stack trace without a request ID cannot be triaged. |
| `chore/monitoring-alarm-identity` (#42) | Alarm names inside the SNS topic policy prefix | The topic policy authorises `UniBudgetStack-*`; a differently named stack would deploy alarms that could not notify. |
| `feat/monitoring-ownership` (#43) | Dedicated `UniBudgetStack-Monitoring`, alarms removed from app stack | One owner per alarm; an app release must not recreate or duplicate monitoring resources. |
| `fix/deploy-test-database` (#44; tagged v1.1.1) | PostgreSQL service for the deploy test gate | The deploy workflow ran tests but had no database; the gate failed for the right reason. |
| `fix/migration-test-teardown` (#45; tagged v1.1.2) | Tolerate only the expected `57P01` teardown race | Test isolation, not a production bug; other pool errors still fail. |
| `fix/cloudfront-origin-gate` (#46; tagged v1.1.3) | Read `Origins.Items` instead of the wrapper object | The gate was correct in intent and wrong in its AWS response shape. |
| `docs/v1.1.3-release` (#47) | Record the verified production release | Evidence that the tag, digest and live checks matched. |
| `feat/release-readiness-closeout` (#50) | Fail a release without `X-Request-Id`; close out readiness records | Correlation is only useful if a release cannot ship without it. |

### Phase 4 — Static site and recovery

| Branch / PR | What it changed | Why it exists |
| --- | --- | --- |
| `feat/static-blog-and-ci` (#49) | `src-static/`, `astro.config.static.mjs`, `deploy-static.yml`, build/live verification, safe correlated 500, chaos-drill runbook | The blog does not need sessions, a database or a Node server; separate artifact, separate failure domain, cheaper caching. |
| `fix/static-deploy-test-database` (`d22cce4`, on `main` after #49) | Integration database for the static deploy gate | The static workflow runs the full suite; it needs the same test database as CI. |
| `feat/scheduled-database-backup` (#51) | Daily `pg_dump` workflow, manifest, S3 upload | Supabase Free has no scheduled backups or PITR; recovery needed a real artifact. |
| `fix/backup-connection-and-tls` (#52) | libpq fields, pooler CA, `verify-full` | A connection string supplied as a CLI argument leaks and does not verify TLS the way the app does. |
| `fix/backup-manifest-version` (#53) | Record the PostgreSQL version, not the Debian package suffix | A recovery manifest that records `17.11-1.pgdg…` is not a usable version claim. |
| `docs/record-verified-backup` (#54) | Record the verified backup and drill hand-off | Keep verified evidence separate from “the workflow exists”. |

### Stale or superseded branches — what to say if asked

- `13-add-static-site-deployment-infrastructure`, `3-add-zod-frontmatter`,
  `add-tests`, `unibudget`: old names or fully merged work; they have no unique
  commits ahead of `main`.
- `add-cdk`: the first CDK and CI attempt, merged then reverted by #27; the one
  remaining `tsconfig` commit is superseded by the rebuilt workflow.
- `feat/supabase-migration-runner`: a work-in-progress duplicate of the AWS
  deployment branch, superseded by the merged PR #37; one commit is not in
  `main` because the work was rebased during review.
- `chore/monitoring-alarm-identity` (current checkout): its content was merged
  in PR #42 and then carried into the static/observability branch; the local
  branch is behind `main` and should not be presented as the final state.

The honest answer to “why so many branches?” is: one branch per reviewable risk,
merged by PR, kept for audit. Some were renamed or rebased during review, and
three were pure fixes discovered by the release gates.

### If asked “what did you personally do?”

Use this only if it is true for you; adjust the list to the parts you actually
owner. A defensible answer is concrete, not a list of branch names:

> I wrote the application and auth layer, the migration runner, the CDK
> application and monitoring stack, the deploy, static and backup workflows, and
> the logging and request-correlation middleware. I also ran the releases, so I
> found and fixed the three gate failures myself. The architecture records are
> mine; where I did not finish something, the ADR says so.

**If AI assisted, do not use this paragraph unchanged.** The repository has one
Codebuff-authored commit on GitHub (`24919e6`, PR #37) and local
Freebuff/agent refs. Say what you actually did, and use the disclosure script in
[defence-red-team.md](defence-red-team.md#4-the-ai-attribution-answer). Do not
claim every line.

Evidence to point at: `hello-cdk/lib/cdk-stack.ts`,
`hello-cdk/lib/monitoring-stack.ts`, `.github/workflows/deploy.yml`,
`.github/workflows/deploy-static.yml`, `.github/workflows/backup-database.yml`,
`src/middleware/auth.ts`, `src/lib/serverLogger.ts`, and `scripts/migrate.mjs`
(the backup workflow is on `origin/main`).

---

## 3. Architecture defence — decision, rejected alternative, trade-off

The [ADR index](adr/README.md) is the source of truth. This table is the spoken
version.

| Decision | Rejected alternative | Why | Trade-off you should admit |
| --- | --- | --- | --- |
| Astro SSR with the Node standalone adapter (ADR 0001) | Static Astro output; separate SPA + API | Sessions, per-user queries and authenticated APIs need request-time execution. | Needs a Node runtime and graceful shutdown; SSR route bugs survive a successful static build. |
| Supabase PostgreSQL with a dedicated `unibudget_app` role (ADR 0002) | Retained RDS; direct connection without pooler; admin role at runtime | Managed Postgres, verified TLS, and a real privilege boundary between runtime and migrations. | Runtime depends on an external provider; schema recovery is forward-only and needs a verified restore point. |
| Docker on ECS/Fargate (ADR 0003) | EC2 + process manager; Lambda/App Runner; single-stage image | Repeatable artifact, no host patching, existing ALB/VPC model, non-root runtime. | 0.25 vCPU / 512 MiB is cost-sized, one task is not HA, and the image has no shell tooling for diagnosis. |
| CloudFront in front of the ALB (ADR 0004, 0011) | Public ALB with ACM; ALB-only HTTP; custom domain | HTTPS without owning a domain; only CloudFront's prefix list can reach the ALB; no edge cache for user data. | Distribution replacement changes the hostname; viewer TLS minimum is still TLSv1. |
| Separate liveness and readiness (ADR 0005) | One DB-dependent endpoint; one process-only endpoint | A database outage must drain traffic, not trigger endless task replacement. | During an outage there is no ready capacity; a task can be alive but not ready. |
| Rolling deployment with a 5xx deployment alarm (ADR 0006) | Recreate; blue/green; canary | Automatic rollback without a second target group or deployment controller; the alarm fires in about a minute. | Old and new tasks coexist briefly; rollback restores the task definition, not the database; the breaker alone needs three failed launches at this size. |
| Test-gated deploy, migrations before rollout (ADR 0007) | Separate test/image/deploy workflows; post-rollout migration | One auditable path, one image identity, and no new code seeing an old schema. | Slower releases; a post-deploy check can still fail a release; recovery needs an operator attestation. |
| Immutable ECR tags, semver, digest verification (ADR 0008) | Mutable `latest` + SHA tags; digest-only | A tag cannot be repointed; the digest is the content identity; OCI labels map image to commit. | Every release needs a new version; failed releases leave tags for audit; 10 tagged / 10 untagged is a finite window. |
| Structured logs, two metric filters, five alarms (ADR 0009) | No alarms; stack-created SNS topic; third-party logger | Errors become queryable and correlatable; alarms map to operator actions; a `status >= 500` filter also catches a `warn` 5xx with no exception. | Log volume grows from probes; all five alarms are deployed in production, `Request5xx` in the monitoring stack; probe 5xx can trip the fast alarm, which is intended. |
| Monitoring in its own stack (ADR 0009 amendment) | Keep alarms inline in the app stack | One owner; an app release cannot recreate or duplicate alarms and the metric filter. | Monitoring changes need their own diff and approval; the stack imports rather than owns resources. |
| GitHub OIDC (ADR 0010) | Long-lived access keys; hand-written policy | No static AWS credentials in GitHub. | **Proposed, not applied:** the role still has `AdministratorAccess`; OIDC fixes credential lifetime, not authorization scope. |
| Independent static blog artifact (README, `astro.config.static.mjs`) | Prerender the blog inside the SSR app; copy the blog into a second repo | Static pages have no session or database need; separate build cannot leak API/middleware/server code; shared components keep one source of truth. | Two deploy workflows; shared `src/**` changes can trigger both; deleted articles leave stale S3 objects until deliberately removed. |

### The deployment order in one line

`validate inputs and recovery attestation → tests → CDK prerequisites and stack
check → ECR retention preflight → CloudFront origin check → build and push
immutable image → run migration task → deploy stack → wait for stable service →
verify running digest → verify /api/health, /login, a real blog slug and an
unknown-slug 404.`

### The failure model in one line

- Database down: `/api/health` 503, `/api/live` 200, ALB drains the target, ECS
  leaves the task running, `UnhealthyTargets` alarms.
- App process hung: ECS liveness fails, task is replaced.
- Bad release: readiness keeps the bad task out of the target group, the 5xx
  deployment alarm fails the rollout and restores the previous task definition;
  the previous image remains in ECR; the database is not rolled back.
- Bad migration: deploy stops before rollout; restore from the verified recovery
  point and re-run the matching release.

---

## 4. Likely questions and short answers

### Architecture

**Why not just deploy the Astro blog statically?**
The blog could be static — and it now is. The application cannot: the dashboard,
transactions, budgets and auth APIs need a session and a per-user query on every
request. Static output cannot enforce either.

**Why keep the blog in the same repository if it is a separate deployment?**
The content, components, layouts and styles are shared. A second repository would
duplicate the design and let copy drift. The build is separated by `srcDir` and
`outDir`, not by repository.

**Doesn't the SSR app still serve `/blog`?**
Yes, from the same content collection. The static deployment is the public,
session-free copy with its own distribution and cache behaviour. The separation
is about the artifact and failure domain, not about deleting a route from the
app. If I were tightening it, I would make the static site the only public blog
host and link the app's blog routes to it.

**Why ECS/Fargate instead of Lambda or App Runner?**
The Astro Node adapter produces a long-running server, and the project already
had a VPC, ALB and CloudFront model. Lambda would need an adapter and a different
deployment model; App Runner would replace the ALB/ECS controls the project is
assessed on. Fargate is the smallest change that gives a real container.

**Why is the ALB HTTP? Isn't that insecure?**
The ALB accepts port 80 only from CloudFront's origin-facing managed prefix
list. A viewer cannot reach it directly; CloudFront terminates TLS and redirects
HTTP to HTTPS. The origin hop is inside AWS's network path and is not a public
plain-HTTP endpoint.

**Why no custom domain?**
I do not own a domain, and inventing one would be a false claim. CloudFront's
managed certificate gives HTTPS on `*.cloudfront.net`. A custom domain would need
domain ownership, an ACM certificate in `us-east-1`, DNS validation, a CDK change
and post-change verification. It is documented as optional, not hidden.

**Why not blue/green if you care about rollback?**
Blue/green adds a second target group, CodeDeploy, listener switching and extra
alarms. This is one service at one task. Rolling with a 5xx deployment alarm
gives a bounded, tested rollback path without that operational surface. I call
it rolling, not blue/green.

**Why one task? Isn't that a single point of failure?**
It is a cost decision, and I should say so plainly. The VPC spans two AZs, but
desired count is one, so an AZ failure causes replacement rather than continuous
capacity. The task-count alarm makes the gap visible. A second task is the next
availability step, not a claim already delivered.

**Why retain RDS if the app uses Supabase?**
The RDS instance was already provisioned. Removing it is a cost and data-retention
decision, not a runtime one, and it needs a verified snapshot plus approval. It is
retained, unused by the app, and documented as such.

### Data, auth and security

**How do you prevent one user reading another user's data?**
Every user-owned query is scoped by the user ID from the validated session, never
from a request body or query string. The middleware sets `locals.userId` only
after validating the token hash. The database role is `unibudget_app`, not an
admin role, and the migration runner revokes Supabase Data API access from the
application tables.

**How are passwords and sessions stored?**
bcrypt with 12 salt rounds. A dummy hash is compared when the email is unknown,
so login timing does not reveal whether an account exists. Session tokens are a
32 hex characters (about 122 bits of UUIDv4 entropy), stored only as a SHA-256 hash, with
`HttpOnly`, `SameSite=Strict`, `Secure` in production and a 24-hour expiry. The
raw token is only in the cookie.

**Where do secrets live?**
AWS Secrets Manager. The CDK creates empty secrets and they are populated out of
band; the task execution role reads only the secrets it needs. The image contains
no credentials or CA certificate. The backup workflow writes credentials to
temporary files with mode `600` and deletes them on exit.

**Why does the application fail closed if it is not `unibudget_app`?**
A production task connected as an admin or a Supabase API role would have far more
privilege than the application needs. The role assertion runs in the middleware
(and again in `/api/health`, which is exempt from the middleware) and returns 503
rather than serving data under the wrong identity.

**Is the rate limiter distributed?**
No, and the code says so. It is in-process and memory-bounded; it protects a
single task and is defence in depth. Production-grade limiting belongs at AWS WAF
or a shared store such as Redis. With one task it works; with several it would be
per-task, not global.

### Operations

**Why two health endpoints?**
Liveness answers “is the process alive?”; readiness answers “can it serve data?”.
If liveness queried the database, a database outage would make ECS replace healthy
tasks without fixing the dependency. If readiness did not query it, the ALB would
route to a task that cannot serve. The split is the whole point.

**How does a database outage behave?**
`/api/health` returns 503 after a bounded query (2 s server-side, 2.5 s client
timeout), `/api/live` stays 200, the target becomes unhealthy after three failed
checks, and the `UnhealthyTargets` alarm fires. Tasks are not replaced. When the
database returns, readiness recovers and the target returns to service.

**How does rollback work?**
The service watches a CloudWatch **deployment alarm**. A 5xx access record is a
`warn` record, so it drives a separate `status >= 500` metric filter; the alarm
enters `ALARM` within a minute, and ECS fails the rollout and restores the last
completed task definition automatically. The circuit breaker stays enabled, but
its threshold is a minimum of three failed tasks, which on a one-task service is
roughly 25 minutes — too slow to be the mechanism. The previous immutable image
is still in ECR, and the workflow verifies the running tag and digest, not just
`services-stable`. A rollback does not reverse a migration; database recovery is
a separate, restore-based action. In run 2 the alarm fired 33 seconds after the
first failed probe and ECS rolled back with no operator action in 3 m 10 s. The
same alarm is now live in production and the service watches it; no production
rollout has failed since, so that path is configured there but unexercised.

**Why not run migrations after the rollout?**
New code could observe a schema it does not support. Migrations run as a one-off
task before the service update. During a rolling deploy old and new tasks coexist,
so migrations must be compatible with both; that is a documented constraint, not
an accident.

**Why immutable tags?**
A mutable `latest` cannot prove what is running. The semantic tag identifies the
release, the digest identifies the content, and OCI labels map the image to the
commit. For a normal release, the workflow rejects a non-semver tag, a lightweight tag,
and a tag that does not point at the dispatched commit. The cost is that every
release needs a new version and retention is finite.

**Why did three releases fail?**
Each failed before any image was pushed, for a different reason: no database in
the deploy test gate, a `57P01` teardown race, and the wrong AWS response shape
for CloudFront origins. That is the gate doing its job. I fixed each cause in its
own branch and kept the failed tags for audit.

**Why is monitoring a separate stack?**
The application stack change set also carried ECS, task-definition and IAM
changes, and a second copy of the alarms already existed. Two owners would create
duplicate alarms and a duplicate metric filter, double-counting errors. The
monitoring stack imports the log group, target dimensions and SNS topic; the app
stack test asserts it owns no alarms.

**Why import the SNS topic instead of creating it?**
An unconfirmed email subscription is not reliable, and baking an address into
infrastructure configuration is not appropriate. The topic and its confirmed
subscription are operator-managed prerequisites. The stack imports the ARN and
never creates or replaces the topic.

**What do you log, and what do you deliberately not log?**
One JSON access record per request: timestamp, level, event, `requestId`, method,
path, status, duration. Errors add `errorName` and an optional five-character
SQLSTATE. I do not log query strings, cookies, authorization headers, bodies,
SQL text, user IDs, emails or amounts. Paths are capped at 512 characters.
Error messages and stack traces are never serialised.

**How does request correlation actually work?**
The middleware accepts `X-Request-Id` only when it is 8–64 characters of
`[A-Za-z0-9._-]`; otherwise it generates a UUID. It runs the request inside
`AsyncLocalStorage`, so existing `logServerError(event, error)` call sites attach
the request fields without changing their signatures, and concurrent requests
cannot mix context. The response carries `X-Request-Id`; a 5xx caused by an
exception produces one `error` record and one `warn` access record with the same
ID. A 5xx returned without an exception only has the `warn` record and is caught
by the ALB alarm instead.

**Why does a 5xx access record use `warn`?**
So one failed request increments `StructuredErrorCount` once, through its
exception record. If the access record were `error` too, the metric and its alarm
threshold would double-count every failure.

### Static site and backup

**Why is the static build a separate config instead of `output: 'static'`?**
The SSR app contains API routes, middleware, sessions and dashboard pages. A
static build of that source would either fail or ship code the blog does not need.
`src-static/` has only the public pages; the shared content and components come
from `src/`. `dist-static/` cannot overwrite the SSR `dist/`.

**How do you know the static build is actually static?**
`scripts/verifyStaticBuild.mjs` fails if a required page is missing, if an article
page has no rendered heading, if the index/RSS/sitemap does not link an article,
or if a server bundle or API route leaked into `dist-static`. The live workflow
then verifies the homepage, every article, assets, HTTPS redirect and a real 404
through CloudFront.

**Why doesn't the static deploy delete removed articles?**
Deleting on upload would make a bad build destructive. The workflow reports stale
objects as warnings and leaves them in place; removing an article is a deliberate
action. That is a safety trade-off, not an oversight.

**What backs up the database?**
A daily 02:15 UTC workflow runs `pg_dump` in custom format through a PostgreSQL
17 container, with `verify-full` TLS against the Supabase CA, checks the archive
with `pg_restore --list`, records SHA-256 and byte size in a manifest, and uploads
both to a private, versioned, SSE-S3 bucket with a 90-day lifecycle. Two manual
production runs were verified. A restore was rehearsed with synthetic data.

**What is the RPO and RTO?**
Not agreed, and I should not invent numbers. The daily schedule bounds exposure
to about a day when every run succeeds; a failed run extends it to the age of the
newest stored object. RTO is unmeasured; a restore has been rehearsed but not
timed end to end into production. Supabase Free has no PITR, so the dump is the
recovery point.

### Process and limits

**What is still not production-grade?**
The deploy role still has `AdministratorAccess`; ADR 0010 is a staged proposal,
not an applied policy. CloudFront viewer TLS minimum is TLSv1. The rollback
drill ran twice: run 1 needed a manual rollback and no alarm fired; run 2 rolled
back automatically on a new 5xx deployment alarm; that alarm and the filter are
now **deployed to production** and the service watches the alarm, though no
production rollout has tripped it yet. RPO/RTO are undecided. Alarm email
receipt is unconfirmed.
Rate limiting is per-process. The service is one task. The RDS instance is
retained but unused.

**What would you do next, in order?**
1. Scope the OIDC role from CloudTrail and Access Analyzer evidence, in a
   non-production account first.
2. Raise the CloudFront minimum TLS policy.
3. Prove the production rollback path with a real failed release, rather than
   the drill account; the alarm and the service wiring are deployed, and the CDK
   entry point and workflow already enforce that order and refuse a rollout
   without the alarm.
4. Agree RPO/RTO, then decide whether the daily dump is sufficient or a paid
   Supabase plan is justified.
5. Add a second task if availability matters more than cost.

**How do you test infrastructure without deploying?**
CDK assertion tests for both stacks (37 today: the original 30 plus the tests
for the rollout guard), workflow contract tests that read the YAML and assert
ordering and guards, a static build verifier, container runtime checks, and
Vitest integration suites against a disposable PostgreSQL 16 service. CI also
builds both sites, the Docker image, and synthesises both stacks.

**What was the hardest bug?**
The CloudFront origin gate. The check was right, but `Origins` in the AWS
response is `{ Quantity, Items }`, and I indexed it as an array. v1.1.2 failed
before pushing an image. The fix reads `Origins.Items` and has a workflow test.
The lesson is to test the shape of the provider response, not just the intent.

**If you had to defend one decision hardest, which one?**
SSR for the app and static for the blog. They look contradictory until you state
the boundary: the blog is public, cacheable and session-free; the app is per-user,
uncacheable and session-bound. Two workloads, two artifacts, one source of truth
for content and components.

---

## 5. Numbers and names to remember

- **11 ADRs**, `0001`–`0011`.
- **4 migrations**: users/sessions/profiles, transactions, category budgets,
  consolidation into one overall monthly budget.
- **2 health endpoints**: `/api/live` (process only) and `/api/health`
  (role + `SELECT 1`).
- **5 alarms** in `UniBudgetStack-Monitoring`: `Target5xx`, `UnhealthyTargets`,
  `LiveTaskCount`, `StructuredErrors`, and `Request5xx`. **4 are deployed in
  production**; `Request5xx` is not.
- **2 metric filters**: `{ $.level = "error" }` → `StructuredErrorCount`, and
  `{ $.status >= 500 }` → `Http5xxCount`. **Only the first is deployed in
  production**.
- **4 releases**: v1.1.0, v1.1.1 and v1.1.2 failed before pushing an image;
  v1.1.3 is the verified production release. The ladder is easy to remember:
  **v1.1.0 failed on the missing test database → PR #44 is tagged v1.1.1, which
  failed on the `57P01` teardown race → PR #45 is tagged v1.1.2, which failed on
  the CloudFront origins shape → PR #46 is tagged v1.1.3, which passed.**
- **10 tagged / 10 untagged** ECR retention; immutable tags; digest verification.
- **256 CPU units / 512 MiB**, desired 1, port 8080, non-root `node` user.
- **7-day** CloudWatch log retention; **90-day** backup object lifecycle;
  daily backup at **02:15 UTC**.
- **306 Vitest tests** in 33 files: **300 pass with no database**, and the six
  PostgreSQL integration tests pass when `BUDGET_TEST_DATABASE_URL` and
  `MIGRATION_TEST_DATABASE_URL` point at a disposable database. On 2026-10-26
  all 306 passed against a fresh PostgreSQL 16 container on `127.0.0.1:5434`,
  the same shape CI provides. Plus **37 CDK tests** in 3 suites.
- **Two CloudFront distributions**: SSR (`E30KFH719MS9Z0`) and static
  (`E2JVO3G1WG2Q2T`, host `d2eip6kpluaijf.cloudfront.net`).
- **One recovery point** for the v1.1.3 release: the S3 dump and manifest under
  `supabase/fkrtduyzpwfrbhooxvpr/20261025T184503Z/`, SHA-256 `bf0fec9a…`.

---

## 6. Two diagrams to have in your head

### Runtime

```text
Browser
  │ HTTPS (AWS-managed certificate, TLS)
  ▼
CloudFront  ── CachingDisabled + AllViewer (cookies, headers, query, all methods)
  │ HTTP, port 80
  ▼
ALB  ── SG accepts only the CloudFront origin-facing prefix list
  │ HTTP, port 8080
  ▼
ECS Fargate  ── Astro Node standalone, non-root, 0.25 vCPU / 512 MiB
  │ PostgreSQL 5432, verify-full + Supabase CA
  ▼
Supabase session pooler  ── role unibudget_app
```

Separately:

```text
GitHub Actions (OIDC) → CloudFormation / ECR / ECS / CloudWatch / SNS
GitHub Actions (OIDC) → S3 (daily pg_dump) → private, versioned bucket
GitHub Actions (OIDC) → S3 static build → static CloudFront distribution
```

### Deploy

```text
inputs + recovery attestation
  → tests
  → CDK build + ECR/CloudFront preflight
  → build and push immutable image (record digest)
  → one-off migration task (exit 0 required)
  → deploy stack with the same tag
  → wait for services-stable
  → verify running tag + digest
  → /api/health, /login, real blog slug 200, unknown slug 404
```

---

## 7. The 60-second version

> UniBudget is a server-rendered Astro budgeting app with a static public blog.
> I split the work into four phases: a Postgres and auth foundation; a container
> runtime on ECS Fargate behind CloudFront and a restricted ALB; SRE work that
> separated liveness from readiness, made releases immutable and migration-first,
> and added correlated structured logs with five alarms in a dedicated monitoring
> stack, the fifth being the deployment alarm ECS watches; and shipping work
> that split the blog onto S3/CloudFront and added a
> verified daily backup. The main architecture defence is that the app needs
> request-time identity and per-user data, which is why it is SSR, while the blog
> is public and session-free, which is why it is a separate static artifact. Three
> releases failed at their gates before v1.1.3, and no failed release pushed an
> image. What remains is explicit: the deploy role is still broad, viewer TLS is
> TLSv1, the rollback drill ran twice and the second run's alarm is now deployed
> and wired into the production service but has not yet tripped there, RPO/RTO
> are undecided, and the service is one task.

---

## 8. Rehearsal checklist

- Open with the thesis sentence, not with “so basically”.
- Say **rolling deployment with a 5xx deployment alarm**, not blue/green, and
  not "the circuit breaker rolled back".
- Say **readiness versus liveness**, not “health checks” in general.
- Say **immutable tag plus digest**, not “we tag the image”.
- Say **migration before rollout, forward-only, restore for recovery**.
- Say **OIDC is applied, least privilege is proposed**. Do not claim both.
- Say **tested, deployed, or verified** — pick the accurate one.
- Name at least one rejected alternative per decision.
- Volunteer the limits before you are asked; it makes the rest credible.
- If you do not know: “I do not have evidence for that; here is how I would get
  it.” Do not improvise a number.
- Have these files open for evidence: [ADR index](adr/README.md),
  [release readiness](release-readiness.md), [chaos drill](chaos-drill.md),
  [logging](logging.md), [alarms](alarms.md),
  [deploy workflow](../.github/workflows/deploy.yml),
  [static deploy](../.github/workflows/deploy-static.yml),
  [CDK stack](../hello-cdk/lib/cdk-stack.ts),
  [monitoring stack](../hello-cdk/lib/monitoring-stack.ts).

---

## 9. Post-brief drill evidence (2026-10-26)

Rollback Drill 2 was executed **twice** in isolated account `293633790894`, in
two separate stack lifecycles. The canonical record is
[rollback-drill-2.md](rollback-drill-2.md) §7 (run 1) and §8 (run 2); the
post-mortem of run 1 is
[rollback-drill-2-result.md](rollback-drill-2-result.md), including a dated
addendum. This is the spoken version.

> I deployed a drill-only image whose readiness endpoint returned 500. The load
> balancer never sent it viewer traffic, so the public endpoint stayed 200.
> In the first run, ECS detected the bad task in 1 minute 52 seconds, but no
> CloudWatch alarm fired — the target left the group too fast for
> `UnHealthyHostCount`, and a 500 is a `warn` access record, not an `error` — so
> the circuit breaker never reached its threshold of three failed tasks and I
> rolled back manually. That run told me exactly what was missing. I added a
> metric filter on `status >= 500` and a one-minute alarm, attached it to the
> service as an ECS deployment alarm, and re-ran: the alarm went to `ALARM` 33
> seconds after the first bad probe, ECS failed the deployment, and it rolled
> back to the baseline digest in 3 minutes 10 seconds with no operator action.
>
> What I still do not claim: the alarm has been proven to stop a *drill*
> rollout, not a production one, and no one has confirmed an alarm email
> arrived. Run 1's evidence is in `drill-evidence/`; run 2's is in
> `drill-evidence-retest/`.

Do not say production is protected, and do not say an email was received. The
alarm is deployed and the service watches it, but no production rollout has
tripped it, so the rollback path there is configured rather than demonstrated. Do not say "the circuit breaker rolled back" either — run 2's
rollback came from the deployment alarm; the breaker needs three failed task
launches.

If pressed for exact timings, name the origin: in run 2 the broken revision
was applied at 20:32:47Z, the first failed probe was at 20:33:37Z, the alarm
went `OK → ALARM` at 20:34:10Z (33 s after that probe, 1 m 23 s after the
update), ECS began rolling back at 20:34:14Z, and the service reached steady
state on the baseline at 20:35:57Z — 3 m 10 s after the update. The 33 s and
the 3 m 10 s are measured from different points, so say which one you mean.
For run 1 the same applies: "1 m 52 s" is from the bad task starting at
19:11:50Z to the target going unhealthy at 19:13:42Z, which is 2 m 5 s from the
19:11:37Z update.

If asked why you intervened in run 1: the drill window was bounded and the
baseline was still serving; restoring the known-good revision was the
lower-risk action. The cost was that automatic rollback stayed unproven until
run 2, which is why the second run was necessary.
