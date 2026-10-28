# CloudOps guide

How CloudOps is built, configured and deployed, its data model, and how to add a cloud provider.
Start with the [README](../README.md) for what CloudOps does and a quick start.

## Contents

1. [Architecture](#architecture)
2. [Configuration](#configuration)
3. [Deployment](#deployment) (including [backup & restore](#backup--restore))
4. [Data model (ERD)](#data-model-erd)
5. [Provider plugin guide](#provider-plugin-guide)

---

## Architecture

CloudOps is a **modular monolith**: one API process (plus background workers that can run
in-process or standalone) with each feature in its own module (routes → service → repository).
Modules talk to each other through the DI container and a typed event bus, and providers plug in
through a contract. It grows by adding modules and plugins, not by rewriting.

```
Browser (React SPA, nginx) ──HTTPS/JSON──▶ API (Express)
                                            │  routes → services → repositories (Prisma)
                                            │  BullMQ workers: sync · cost · tags · evaluation · remediation · maintenance
                                            ├──▶ Postgres  — authoritative offline-first cache
                                            ├──▶ Redis     — queues, rate-limit counters, locks
                                            └──▶ az CLI    — one isolated profile per organization
```

### Modules (`apps/api/src/modules`)

| Module                        | Responsibility                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`                        | Sign-in, token rotation, sign-out, password change, sessions, `requireAuth` / `requirePermission`                                                       |
| `users`                       | Admin user management (create, roles, deactivate, reset password, sessions, sign out everywhere); people directory for pickers                          |
| `audit`                       | Append-only audit trail, query API with correlation filters, CSV export                                                                                 |
| `providers`                   | Provider registry, organizations (service principals), connectivity tests                                                                               |
| `sync`                        | Inventory discovery → reconcile → change detection → deletion flagging                                                                                  |
| `inventory`                   | Read APIs: resources, facets, detail (dependents, portal link), history, activity, CSV export; resource operations (refresh from provider, re-evaluate) |
| `tags`                        | Tag writes to Azure (single resource, or resource-group fan-out as a job)                                                                               |
| `finops`                      | Cost sync (Cost Management) and cost analytics                                                                                                          |
| `topology`                    | Relationship graph queries                                                                                                                              |
| `standards`                   | Rule catalog, compliance evaluation, scoring                                                                                                            |
| `work`, `workspaces`, `views` | Tasks and recurring reviews, markdown docs, saved inventory views                                                                                       |
| `dashboard`                   | Aggregated overview + the transparent priority queue (`priority.ts`)                                                                                    |
| `remediation`                 | Action catalog, dry-run plans, approval (four-eyes), background execution, verification                                                                 |
| `automation`                  | Trigger → conditions → actions rules (notify, raise work), previews, run history                                                                        |
| `notifications`               | In-app inbox; the notifier turns domain events and scheduled checks into notifications                                                                  |
| `search`                      | Global search (names, ids, `key=value` tags, IPs) for the command palette                                                                               |
| `drift`                       | Change explorer + provider activity-log lookup (who changed it)                                                                                         |
| `system`                      | Status, job monitoring (list, detail, retry, remove), duplicate-record repair                                                                           |

### Request pipeline (`apps/api/src/app.ts`)

Middleware runs in this order:

1. **`trust proxy`**: set from `TRUST_PROXY`, so the client IP is correct behind a reverse proxy.
2. **Request context**: accepts a safe incoming `X-Request-Id` or generates a UUID, echoes it in
   the response, and binds it (plus the IP and user id) to an `AsyncLocalStorage` context. Every
   log line and audit entry written during the request carries it automatically.
3. **Access log**: one structured line per request (method, route, status, duration, user), and
   **metrics**: request counts and latency histograms by route template (`infra/metrics.ts`).
4. **helmet** (security headers), **CORS** (the `CORS_ORIGIN` allow-list; it exposes
   `X-Request-Id` and `Retry-After`), and a **JSON body parser** (2 MB cap).
5. **Health endpoints**, **`/metrics`** (only when `METRICS_TOKEN` is set) and **Swagger UI**,
   outside `/api`.
6. **`/api`**: `Cache-Control: no-store`, then **rate limiting** per route, then the module
   routers (authenticated unless noted), then a JSON 404 for unknown API routes, then the
   **error handler**.

#### Error contract

Every error has the same shape. The status code and `code` are stable, and the message is safe
to show a user:

```json
{ "error": { "code": "validation_error", "message": "Invalid request", "details": [...], "requestId": "…" } }
```

| Status    | `code`                                            | Cause                                                                                         |
| --------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 400       | `validation_error`, `invalid_json`, `bad_request` | Zod validation, malformed JSON                                                                |
| 401 / 403 | `unauthorized` / `forbidden`                      | No, invalid or expired token; disabled account / missing role                                 |
| 404       | `not_found`                                       | Unknown route or record (including Prisma P2025)                                              |
| 409       | `conflict`                                        | Unique or foreign-key violation, admin guard rails                                            |
| 413       | `payload_too_large`                               | Body over 2 MB                                                                                |
| 429       | `rate_limited`                                    | Includes `retryAfterSeconds` and a `Retry-After` header                                       |
| 503       | `service_unavailable`                             | Database unreachable or pool exhausted                                                        |
| 500       | `internal_error`                                  | Anything unexpected. The generic message is sent; details go to the log under the `requestId` |

The web client turns these into human messages (`apiErrorMessage`) and shows the `requestId`
as a reference on server errors.

### Security model

#### Accounts, roles, sessions

- **Admin-managed accounts.** Self sign-up is closed. `POST /api/auth/register` requires an
  admin, and the Users page (`/api/users`) is the main path. The first admin comes from
  `SEED_ADMIN_*` on first boot.
- **Permissions.** `packages/core/src/permissions.ts` is the single catalog: named permissions
  (`inventory.sync`, `remediation.approve`, `audit.read`, `system.manage`, …) and the roles that
  bundle them — `admin` (everything), `operator` (everything except providers, users, audit and
  system), `finops`, `security` and `viewer` (reads only). Routes use
  `requirePermission(...)`; the user DTO carries the effective permissions, so the UI
  (`usePermissions().can()`) never offers an action the API would refuse. Everyone can read the
  estate. The Users page shows the full role × permission matrix. A saved view can always be
  changed by its author.
- **Tokens.** The access JWT (`JWT_ACCESS_TTL`, default 15 min) is sent as a Bearer header. The
  algorithm is pinned to HS256 on both signing and verification.
- **Refresh tokens.** The refresh token (`JWT_REFRESH_TTL`, default 7 days) is stored hashed in
  `Session` and is **strictly single-use**. Rotation is an atomic compare-and-revoke, so of
  several concurrent refreshes with the same token exactly one succeeds.
- **Tokens in the browser.** Tokens live in `localStorage`, which every tab shares. So the web
  client:
  - serializes refreshes across tabs with the Web Locks API, re-checking whether another tab
    already rotated the pair;
  - follows sign-in and sign-out done in other tabs through `storage` events;
  - on page load, ends the session only on a definitive rejection. A network error or 5xx shows a
    "Can't reach CloudOps" retry screen and keeps the session.
- **Temporary passwords.** A password someone else set has `mustChangePassword` on the user.
  This covers admin create or reset, a generated CLI reset, and the seeded admin. Signing in with
  the documented default seed password sets the flag too. The web app then blocks on a dialog
  that can't be dismissed until the user chooses their own. Enforcement is in the UI only; the
  API does not block other calls.
- **Password length** is 10–72 **bytes**, because bcrypt ignores everything past 72.
- **Revocation.** Every authenticated request checks the user's `isActive`, roles and
  `passwordChangedAt` through a 30-second per-process cache. So deactivation, role changes,
  password changes and "sign out everywhere" reach every device within 30 seconds, without a
  database hit per request. Access tokens issued before the last password change or "sign out
  everywhere" (`User.sessionsValidAfter`) are rejected; tokens carry a millisecond issue time
  (`ims`) so a token minted in the same second as the cutoff can't slip through.
- **Sessions.** Users see their signed-in devices (from the user agent) and can sign one out (it
  can't renew; locked out when its short-lived access token expires) or all others (immediate).
  Admins can see a user's devices and sign them out everywhere. All of it is audited.
- **Sign-in hardening.** Password checks take constant time even for unknown emails (a dummy
  bcrypt compare). Failures are audited with a reason. Sign-in is rate limited per account+IP
  (10 per 15 min) and per IP (100 per 15 min).
- **Guard rails.** Admins cannot deactivate themselves or remove their own admin role, and the
  last active admin cannot be removed (409).

#### Rate limiting (`http/rate-limit.ts`)

A fixed window in Redis (one atomic Lua `INCR`+`PEXPIRE`), so limits hold across API processes
and restarts. It **fails open**: if Redis is down, requests go through and a warning is logged,
because abuse protection must not become an outage. Limits are applied to:

- sign-in, refresh, sign-out and password change
- sync and cost-sync enqueue, standards evaluation
- connectivity tests, CSV export
- tag writes and user administration

Switch it off with `RATE_LIMIT_ENABLED=false`.

#### Audit trail (`modules/audit`)

`AuditService.record()` writes one `AuditLog` row with:

- the actor (id and display name)
- the action (e.g. `auth.login.failed`, `user.update`, `provider.account.create`, `sync.enqueue`,
  `resource.tags.write`)
- the entity, and metadata that never contains secrets
- the IP and the `requestId`

It never throws. A failed audit write is logged and never breaks the business action. Admins
browse and filter it on **Settings → Audit log**.

#### Cloud credentials

- Service-principal secrets are stored in `packages/credentials`, an AES-256-GCM encrypted file in
  `CLOUDOPS_DATA_DIR`. They are **never** written to Postgres and never returned by the API.
- **Per-organization `az` profiles.** Each organization logs in to its own `AZURE_CONFIG_DIR`
  under `<data dir>/az-profiles/<hash of tenant+client>`. Concurrent syncs, cost pulls and tag
  writes for different orgs never share token caches or switch each other's active account.
  - Logins are shared by concurrent callers and refreshed after 10 minutes of age.
  - A `NOT_LOGGED_IN` error triggers one forced re-login and a retry.
  - Profiles of removed orgs are pruned.
  - A subscription that no configured org can see is refused (`FORBIDDEN`) rather than run under
    the wrong identity.
- **The `az` executor** (`provider-azure/src/az-exec.ts`) takes arguments as an array and never
  uses a shell string. It also enforces an allow-list of command groups, timeouts and JSON
  parsing.
  - **Tag names** reach `az` as `name=value` argv entries. So they may not start with `-` (az
    would parse `--operation=Replace` as a flag), may not contain `=`, and a request carries at
    most 50 tags. This is enforced by the API schema and again at the provider.
  - On Windows it runs the CLI's bundled Python directly, so arguments never pass through
    `cmd.exe`.
  - Where only `az.cmd` exists, every argument is escaped for `cmd.exe`.
  - Write operations are refused when `AZURE_ALLOW_WRITE=false`.

#### Transport and browser

- helmet headers apply on the API.
- The web container is unprivileged nginx (uid 101). It sends a strict CSP (`default-src 'self'`,
  with `connect-src` limited to the API origin), `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin` and `Permissions-Policy`.
- Hashed assets are served immutable, and `index.html` is served `no-cache`.
- Markdown in workspaces is rendered by a small escaping renderer (no raw HTML).
- CSV exports neutralise spreadsheet formula injection.

#### Configuration safety

In production (`NODE_ENV=production`) the API **refuses to boot** if either JWT secret is a known
default, shorter than 32 characters, or equal to the other. Outside production the same problems
are logged as warnings. See [Configuration](#configuration).

### Background jobs (`apps/api/src/workers`, BullMQ on Redis)

| Queue         | Worker                                | Behaviour                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`        | inventory sync                        | Enqueue is **idempotent** (Redis lock + active-run check): while a run is queued or running, the same run is returned (`deduplicated: true`). The BullMQ job id is the run id. A failed job marks its run failed.                                                    |
| `finops`      | cost sync (+ optional daily schedule) | Deduplicated against a waiting or active cost sync.                                                                                                                                                                                                                  |
| `tags`        | resource-group tag fan-out            | Concurrency 1. Progress `{done,total}` is polled by the UI. One job per resource group at a time.                                                                                                                                                                    |
| `evaluation`  | standards evaluation                  | Queued after every completed sync and cost sync (and on demand). Streams resources in keyset batches inside one transaction; emits `compliance.evaluated` with the rules that newly started failing.                                                                 |
| `remediation` | remediation runs                      | Concurrency 1. Changes targets one at a time through the provider's `executeAction`, reads each back to verify, re-evaluates them, records everything.                                                                                                               |
| `maintenance` | housekeeping                          | At boot and every 15 minutes: purges sessions expired or revoked more than 7 days ago, fails runs (sync and remediation) interrupted by a crash, sends due/overdue and expiring-exemption reminders, and purges notifications and automation history past retention. |

**Job monitoring.** System status lists jobs per queue and state with a secret-free payload,
error and stack, links each to what it worked on, and lets `system.manage` retry a failed job
or remove one that isn't running. Remediation jobs are never retried from there — a change is
requested (and approved) again.

**Request-path safety.** Queue connections wait for Redis indefinitely, which is what workers
need. So HTTP handlers that enqueue or read job state first ping the fail-fast Redis client and
put a time limit on queue reads. During a Redis outage they return `503` at once instead of
hanging, and a sync that could not be queued is marked failed rather than left "queued".

**Error handling.** Every queue and worker has an `'error'` listener feeding a throttled
reporter: one line per component per minute, with a suppressed count, plus a
`connection restored` line. Without a listener, BullMQ writes a raw stack trace for every
reconnect attempt. Job processors run inside a log context (`requestId: job:<queue>:<id>`).

Workers run inside the API process by default (the single-container deployment). To scale them
out, run `pnpm --filter @cloudops/api worker` (`workers/main.ts`) as its own process. Shutdown
is graceful: on SIGTERM the HTTP server stops accepting requests, workers finish their current
job, and queues and connections close, all within a 25-second deadline.

### Sync engine (`modules/sync/sync.engine.ts`)

1. **Discover** subscriptions per organization, then resource groups and resources through Azure
   Resource Graph (falling back to `az resource list` if Resource Graph is unavailable).
2. **Reconcile** per subscription:
   - Existing rows are prefetched in batches.
   - New resources are created with a `Created` lifecycle event.
   - Changed fields produce `ChangeEvent`s, applied transactionally per resource.
   - Unchanged rows only get `lastSeenAt` bumped, in one batched statement.
3. **Deletion flagging** runs after _all_ subscriptions are processed, so a resource that moved
   between subscriptions is not mistaken for a deleted one. A resource that is active in the DB
   but not seen anywhere this run is marked `state = deleted`, with a lifecycle event. Two guards
   prevent false deletions caused by an outage or a permissions change:
   - A subscription whose discovery returned **zero** resources is skipped.
   - If more than **50%** of a subscription's resources (and at least 20) would be deleted, that
     subscription's deletions are skipped and reported in the run summary.
   - Resources that reappear later are restored automatically.
4. **Relationships** are rebuilt from resource properties (topology).

Deleted resources stay in the database with their history and cost. The inventory hides them by
default, with a state filter to show them.

#### Resource identity

Azure resource ids are case-insensitive, and Azure doesn't return them in a consistent case
(`resourceGroups/APP-PROD` one day, `…/App-Prod` the next). The sync matches existing rows on the
lower-cased id, so a case change is the same resource, not a new one. The cost engine and the
standards engine also key on the lower-cased id.

Databases from before this fix may hold duplicate rows. **System status → Data integrity**
previews and merges them: cost, history, relationships, links, docs and exemptions move onto the
active row, and the extras are deleted. Merging is admin-triggered only.

`properties` (the ARM configuration) is refreshed on every sync through a content hash, even when
no tracked field changed. Rules therefore see current settings, and volatile values such as power
state don't create change events.

### Cost engine (`modules/finops`)

Each cost sync pulls `FINOPS_WINDOW_DAYS` of daily cost, paged and with 429 back-off, and replaces
that window **transactionally**. A failed sync never leaves a half-written window. The
per-resource rollup (`costMonthly`, `costDaily`) is recomputed in one set-based statement as the
**trailing 30 days ending at the latest cost date**. It is independent of the sync window, so
"monthly" always means one month.

Every run records a **result per subscription**: updated, no data, disabled (not queried),
throttled, network, no access, unsupported offer, no exchange rate, or error, each with a reason.
The provider throws a `CostQueryError` with a `kind` instead of returning an empty list, so a
failed query is never mistaken for a subscription with no cost. Throttled and network failures
are re-queued for just those subscriptions. `GET /api/finops/coverage` joins the latest result
per subscription (from the retained job history) with the last day of stored cost.

The same recompute also runs once at API start, from stored records with no Azure call, so an
upgrade or a rule change shows correct figures immediately. The dashboard adds the window's
**unattributed** cost (records that match no inventory resource) to the active-resource total,
so its projection matches the FinOps total.

**Reporting currency.** Every stored amount is in `COST_CURRENCY` (INR by default). Azure bills
each billing account in its own currency, and a sponsorship or US account may come back in USD.
The cost sync converts at ingest and keeps `originalCost`, `originalCurrency` and `fxRate` on each
record. The rate comes from `COST_FX_RATES` if pinned. Otherwise it is Microsoft's own rate: the
Azure Retail Prices API prices the same meter in every currency, so the INR price ÷ USD price is
the rate. If no rate is available, that subscription's window isn't replaced, rather than being
stored in the wrong currency. Stored rows are converted at start-up too.

**Overview** (`GET /api/finops/overview`):

- **This month:** to date, the same point last month, last month, a 7-day run-rate and the
  month-end forecast.
- **Spend outside the inventory**, classified:
  - resources that were deleted but are still billing
  - resources never discovered
  - subscription-level charges such as Azure DevOps
- **Savings:** failing cost-optimization rules × each resource's monthly cost.
- **Budgets:** monthly limits per scope, compared with month-to-date spend and the forecast.

Breakdowns can group by scope, or by service type, category, owner or any tag (showback).

### Standards engine (`modules/standards`)

- **Library** (`standards.library.ts`): 45 rules. Each has a category (security, cost,
  reliability, tagging, naming, governance, operations), a severity, what it checks and why, how to
  fix it, the resource types it applies to, and optional parameters. Evaluators read the ARM
  `properties` the sync stores.
- **Built-in standards** (`standards.catalog.ts`): packs of library rules. Opinionated ones ship
  disabled, e.g. CAF naming, required tags and allowed regions. Users switch rules on and off,
  override severity and set parameters. The check itself stays in code.
- **Custom standards:**
  - Add library rules with their own parameters and scope, or build rules from conditions:
    field/operator/value over name, type, region, SKU, owner, tags, any property path, cost or
    age, matching all or any, plus a scope.
  - `POST /api/standards/rules/preview` dry-runs a rule against the inventory.
- **Not applicable.** A rule returns "not applicable" when it can't judge a resource: wrong type,
  out of scope, property not reported, a parameter not set, or a non-production resource for the
  production-only reliability rules. It then records nothing. Only pass and fail count, weighted
  high 3, medium 2, low 1. For example, "Fixed-price resource has cost data" only judges resources
  billed by the hour, so web apps billed through their plan and pay-per-use services are never
  flagged.
- **Exemptions.** An exemption is a reason plus an optional expiry for a rule and resource pair.
  An exempt failure is shown but not scored, and an expired exemption stops applying at the next
  evaluation.

### Priority queue (`modules/dashboard/priority.ts`)

The dashboard ranks what to do first from real sources — failing rules (with how many
production resources they touch), cost anomalies, budgets, spend on deleted resources, failed or
stale syncs, unreachable organizations, pending approvals, overdue work, ownership gaps,
expiring exemptions and recent drift. The score is a severity base (critical 55, high 40,
medium 25, low 10) plus named factors (blast radius, production, share of monthly spend at
stake, days overdue); every factor is returned and shown, so the order is always explainable.

### Remediation (`modules/remediation`)

1. **Catalog** (`remediation.catalog.ts`): each action states what it changes, risk and why,
   reversibility and rollback, disruption, the rules it fixes and the types it applies to.
   Deleting disks or databases is deliberately absent.
2. **Plan** (`POST /plan`): resolves targets (ids, a failing rule, or an inventory filter), shows
   current → desired values, skips with reasons, and the exact provider call. Changes nothing.
3. **Request → approve**: medium/high risk needs a second person (`remediation.approve`, not the
   requester unless `REMEDIATION_SELF_APPROVAL`).
4. **Execute** (`remediation.execute`) on the `remediation` queue; refused unless
   `AZURE_ALLOW_WRITE` and the provider advertises the `actions` capability. The `az` executor
   refuses any mutating verb unless the call explicitly allows writes.
5. **Verify**: each target is read back from the provider; deletes are verified by "not found".
   Targets are re-evaluated so the finding closes, and the run, targets and outcome are audited
   (and mirrored onto a linked work item).

### Automation (`modules/automation`)

Rules are **when** (trigger) → **if** (typed conditions) → **then** (actions). Triggers: new
compliance failures, cost anomaly, budget threshold, configuration drift, failed sync,
unreachable organization, failed remediation. Actions: notify holders of a permission, or raise a
work item — never twice while one for the same condition is open. Actions never change the cloud;
a fix goes through remediation. Each firing acts on at most 25 matches, is recorded with what
matched and what each action did, and failures never propagate into the code that emitted the
event. A preview runs a (draft) rule against today's data without doing anything.

### Notifications (`modules/notifications`)

Stored once and filtered per reader by permission (`audience`) or addressed to one user;
read state is a per-user watermark plus receipts, so neither publishing nor "mark all read" fans
out rows. `dedupeKey` makes repeated checks idempotent. A broadcast isn't shown to the person
who caused it (`actorId`). Sources: sync failures and unreachable organizations, cost problems,
budgets, anomalies, new high-severity findings, remediation requests/decisions/results, work
assignments and @mentions, due/overdue work, expiring exemptions, and jobs that failed for good.

### Inventory navigation

- The list API returns each resource's organization, subscription and resource group names, its
  category, and its failing-check count and worst severity.
- `GET /api/inventory/tree` gives organization → subscription → resource group counts for the scope
  navigator.
- `GET /api/inventory/resources/groups` groups the filtered inventory by organization,
  subscription, resource group, category, type, region or owner. Each group carries the filter
  that selects it.
- Categories derive from the type's namespace (`categoryForType`, shared with topology).
- The web page keeps every filter, the scope, grouping, sort and page in the URL.

### Data & migrations

- The schema is `apps/api/prisma/schema.prisma`. See [Data model](#data-model-erd).
- Changes ship as **versioned Prisma migrations** (`prisma/migrations`). `0_init` is the baseline
  of the pre-migration schema, and later migrations are additive.
- `prisma/migrate.ts` runs on every container start:
  - It applies pending migrations.
  - On a database created by the old `prisma db push` flow, it syncs additively (`db push` refuses
    data loss), marks the existing migrations as applied, and continues as a normal migrated
    database.
  - It finishes with a drift report.
- Multi-row writes that must be all-or-nothing run in transactions: cost window replace,
  compliance results replace, per-resource change application, and user role replacement.

### Observability

- **Logs** are structured JSON from winston. Every line carries the `requestId` and `userId` when
  there is one. Secret-looking keys (password, secret, token, authorization, cookie, api key,
  credential) are redacted before writing.
- **Health checks.** `/health/live` confirms the process is up. `/health/ready` checks Postgres
  and Redis, with latency per check, and returns 503 when degraded. It reports only
  `timeout`/`unreachable` publicly; driver errors, which name hosts and ports, go to the log.
  `/health` is an alias kept for existing probes.
- **System status** (`/api/system/status`, `system.read`) is the on-call view: dependencies, queue
  depths, workers, throughput / failure rate / oldest waiting job per queue, the job browser,
  provider capabilities and unreachable organizations, migrations, last runs, effective settings.
- **Metrics.** `GET /metrics` (Prometheus text format, no client library) when `METRICS_TOKEN` is
  set: `cloudops_http_requests_total` and `cloudops_http_request_duration_seconds` by route
  template (bounded cardinality), `cloudops_queue_jobs` by queue and state, `cloudops_queue_up`,
  `cloudops_jobs_failed_total`, and process memory/uptime. No estate data.
- Sync runs, cost runs and tag jobs are stored and visible in the UI with counts, errors and
  timings.

### Frontend (`apps/web`)

- React Query handles all server state. Each route is its own lazily loaded chunk; the initial
  bundle is about 145 KB gzipped.
- ECharts is tree-shaken (`src/lib/echarts.tsx` registers only the series and components the app
  uses), which roughly halves the chart chunk. Register a new chart type there.
- Requests time out after 30 s (downloads after 5 min). Client errors are not retried; network
  errors and 5xx get two retries.
- Run feeds poll every 3 s only while a run is active, and every minute otherwise. When a run
  finishes, the data it changed is refetched.
- API responses are compressed.
- The API client refreshes tokens transparently. A definitive refresh failure emits a
  session-expired event, which clears cached data and returns the user to sign-in with an
  explanation.
- Navigation entries and actions are shown by permission (`navigation.ts` `permission`,
  `usePermissions().can`); the API enforces the same rules independently.
- **Command palette** (Ctrl/⌘+K, `/`): global search with scope chips and a preview pane, recent
  visits, page and action shortcuts; `g` + key jumps between sections, `?` lists shortcuts.
- Deep links are part of the contract: notifications, the priority queue and automation link
  to `?run=`, `?rule=`, `?tab=`, `?event=`, `?queue=&job=`, `?user=`, `/organizations#id`,
  `/workspaces?scopeType=&scopeId=&doc=`, and every such page reads them.
- For the design system (tokens, components, theming), see `apps/web/src/components/ui`.

### Extension points

- `CloudProvider`: new cloud or platform providers ([Provider plugin guide](#provider-plugin-guide))
- `CredentialProvider`: new secret sources
- `AuthProvider`: `LocalJwtAuthProvider` today; an OIDC / Entra provider can slot in
- `Plugin` (kernel): rules, executors, scoring dimensions
- Event bus: `sync.completed`, `resource.discovered`, `resource.deleted`, `finops.synced`,
  `compliance.evaluated`, `remediation.*`, `work.*`, `job.failed` — typed in `domain-events.ts`;
  the notifier and the automation engine are both plain subscribers.
- Provider actions: `previewAction` / `executeAction` / `getActivity` on the provider contract,
  advertised through the `actions` and `activity` capabilities.

---

## Configuration

The API reads its configuration from the environment:

- **Docker:** the repo-root `.env`, passed in through Compose.
- **Host mode / development:** `apps/api/.env`, if it exists (copy `apps/api/.env.example`), plus
  your shell. Shell variables always win. The file is git-ignored and excluded from images.

It validates every value at boot and exits with a list of problems if any is invalid. The source
of truth is `apps/api/src/env.ts`.

### Core

| Variable             | Default                                 | Notes                                                                                                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`           | `development`                           | `production` enables the fatal secret checks and production log defaults                                                                                                                                                                                                                                           |
| `API_PORT`           | `3000`                                  |                                                                                                                                                                                                                                                                                                                    |
| `CORS_ORIGIN`        | `http://localhost:5173`                 | Comma-separated web origins allowed to call the API                                                                                                                                                                                                                                                                |
| `LOG_LEVEL`          | `info` in production, `debug` otherwise | `error`, `warn`, `info` or `debug`                                                                                                                                                                                                                                                                                 |
| `TRUST_PROXY`        | off                                     | Set when running behind a reverse proxy: a hop count (e.g. `1`, recommended), a comma list of trusted subnets, or `true`. Without it, rate limits and audit entries see the proxy's IP. **`true` trusts every `X-Forwarded-For` hop**, so clients can spoof their IP and dodge rate limits; the API logs a warning |
| `RATE_LIMIT_ENABLED` | `true`                                  | `false` disables all rate limits (not recommended)                                                                                                                                                                                                                                                                 |

### Database and queues

| Variable                                              | Default              | Notes                                                                                           |
| ----------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                        | (required)           | Postgres connection string. Inside Compose the host is `postgres`; in host mode use `localhost` |
| `REDIS_URL`                                           | `redis://redis:6379` | BullMQ queues, rate-limit counters, locks                                                       |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `cloudops`           | Used by the Compose `postgres` service; keep them consistent with `DATABASE_URL`                |

### Authentication

| Variable              | Default                | Notes                                                                                                                                                                                                                                                                                                      |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`   | (required)             | Signs access tokens. **In production** it must be at least 32 characters, not a known default, and different from the refresh secret, or the API refuses to boot                                                                                                                                           |
| `JWT_REFRESH_SECRET`  | (required)             | Signs refresh tokens. Same rules                                                                                                                                                                                                                                                                           |
| `JWT_ACCESS_TTL`      | `15m`                  | Access-token lifetime ([`ms`](https://github.com/vercel/ms) format)                                                                                                                                                                                                                                        |
| `JWT_REFRESH_TTL`     | `7d`                   | Refresh-token (session) lifetime                                                                                                                                                                                                                                                                           |
| `SEED_ADMIN_EMAIL`    | `admin@cloudops.local` | First admin, created by the seed **only if the user does not exist**                                                                                                                                                                                                                                       |
| `SEED_ADMIN_PASSWORD` | `ChangeMe123!`         | Used only when that admin is first created; a warning is logged while it is the default. Changing it later does **not** change an existing password (use the UI or the break-glass reset: `docker compose exec -w /app/apps/api api node --import tsx prisma/reset-password.ts admin@example.com --admin`) |

Generate secrets with `openssl rand -base64 48`.

Rotating a JWT secret signs everyone out: existing tokens stop verifying, and users sign in again.

### Local data and credentials

| Variable               | Default                           | Notes                                                                                                                                                         |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDOPS_DATA_DIR`    | `~/.cloudops` (`/data` in Docker) | Holds the encrypted credential store, its key file, and the per-organization Azure CLI profiles (`az-profiles/`). Back it up                                  |
| `CREDENTIAL_STORE_KEY` | generated key file                | Optional 32-byte key (hex or base64) for the credential store. Supply it to keep the key off the data volume. Losing it means re-entering every client secret |
| `CREDENTIAL_PROVIDER`  | `azure-cli`                       | Credential resolution order hint                                                                                                                              |

### Azure

| Variable                                                                         | Default                  | Notes                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AZURE_ORGS`                                                                     | (empty)                  | JSON array `[{"name","tenantId","clientId","clientSecret"}]`, one entry per Entra tenant. These orgs show as read-only in the UI; an org also added in the UI uses the UI copy |
| `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_ORG_NAME` | (empty)                  | Single-org shorthand for the above                                                                                                                                             |
| `AZURE_CONFIG_DIR`                                                               | `/root/.azure` in Docker | Azure CLI profile used in **host mode** (no service principals). Service-principal orgs always use their own isolated profiles under `CLOUDOPS_DATA_DIR`                       |
| `AZURE_OWNER_TAG`                                                                | `Owner`                  | Tag the sync reads each resource's owner from (case-insensitive)                                                                                                               |
| `AZURE_ALLOW_WRITE`                                                              | `true`                   | Master switch for write-back to Azure (tag writes). `false` makes the platform strictly read-only                                                                              |

### FinOps

| Variable             | Default      | Notes                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FINOPS_WINDOW_DAYS` | `90`         | Days of daily cost each cost sync pulls. A wide window enables custom ranges and period-over-period comparison. The per-resource monthly figure is always the trailing 30 days, whatever this is set to                                                                                                                     |
| `FINOPS_DAILY_SYNC`  | `false`      | `true` schedules a daily background cost sync                                                                                                                                                                                                                                                                               |
| `COST_CURRENCY`      | `INR`        | Reporting currency (ISO code). Every stored and displayed amount is in it. Subscriptions billed in another currency are converted during the cost sync, and the original amount, currency and rate are kept on each record                                                                                                  |
| `COST_FX_RATES`      | (Azure rate) | Optional pinned rates, e.g. `USD=95.5,EUR=101` (1 unit of that currency in `COST_CURRENCY`). Unset: Microsoft's rate, derived from the public Azure Retail Prices API (the same meter priced in both currencies). If no rate can be found, that subscription's cost is not stored, rather than stored in the wrong currency |

### Web (build and runtime)

| Variable            | Where         | Default                 | Notes                                                                                                         |
| ------------------- | ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | build arg     | `http://localhost:3000` | The URL the browser calls. **Baked into the bundle**, so rebuild the web image after changing it              |
| `API_ORIGIN`        | web container | `http://localhost:3000` | Origin allowed by the web Content-Security-Policy `connect-src`. Must match the origin of `VITE_API_BASE_URL` |

### Tests only

| Variable                   | Notes                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `INTEGRATION_DATABASE_URL` | Disposable, migrated database for `test:integration` (default: `cloudops_test` on `localhost:5432`). **The suite writes to it** (test users, sessions, views, audit rows, removed afterwards by run id). Never point it at real data |
| `INTEGRATION_REDIS_URL`    | Redis for the integration suite (default: `localhost:6379`, logical DB 15)                                                                                                                                                           |

---

## Deployment

### Prerequisites

- Docker Desktop or Docker Engine with Compose v2
- For host mode or development: Node 20+ and pnpm 9
- For Azure sync, either:
  - one service principal per Azure organization (Entra tenant), with **Reader** on the
    subscriptions, **Cost Management Reader** for FinOps and **Tag Contributor** for tag
    write-back; or
  - an interactive `az login` on the host (host mode only)

### Azure authentication: pick a mode

Reads (dashboard, inventory, cost, topology, docs) are served from Postgres and need no Azure
connectivity. Only **syncs** and **tag writes** call Azure.

| Mode                             | When                                                | How                                                                                  |
| -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Service principals** (default) | Fully containerized, multi-org, unattended          | Add each org under **Providers → Add organization**, or declare them in `AZURE_ORGS` |
| **Host mode**                    | Reuse your interactive `az login` (e.g. on Windows) | Run the API on the host; Postgres, Redis and web stay in Docker                      |

**Where secrets live.** UI-entered service-principal secrets are kept in an AES-256-GCM encrypted
file, `<CLOUDOPS_DATA_DIR>/credentials/provider-accounts.enc.json` (the `cloudops_data` volume in
Docker). They are never written to Postgres and never returned by the API. The encryption key
is generated beside the file on first write. Set `CREDENTIAL_STORE_KEY` to keep it elsewhere.
Each org also gets its own isolated Azure CLI profile under `<CLOUDOPS_DATA_DIR>/az-profiles/`.

> **Why the host `~/.azure` can't be mounted into the container:** on Windows the Azure CLI token
> cache is DPAPI-encrypted and cannot be decrypted by the Linux `az` in the container. Use a
> service principal, or host mode.

### 1. Configure

```bash
cp .env.example .env
```

The defaults work for a local install. Every variable is documented in
[Configuration](#configuration). Before exposing the platform to anyone else, work through
the [production checklist](#production-checklist).

### 2a. Container mode (default)

```bash
docker compose up -d --build
docker compose ps                 # api and web become "healthy"
```

Four services start: `postgres`, `redis`, `api` and `web`. On every start the API container:

1. **Migrates** the schema (`prisma/migrate.ts`, safe to re-run; see [Upgrading](#upgrading)).
2. **Seeds** roles, the first admin (`SEED_ADMIN_*`, only if no such user exists) and the provider
   record. This step is idempotent.
3. Starts the API and the in-process workers.

Then open http://localhost:5173, sign in, change the admin password (user menu → **Change
password**), and add your organizations under **Providers → Add organization** with **Test
credentials**. The next sync picks them up; no restart is needed.

Optional DB browser: `docker compose --profile tools up -d adminer`, then open
http://127.0.0.1:8080.

### 2b. Host mode

The API runs on the host and reuses your `az login`. Everything else runs in Docker.

```bash
az login
docker compose up -d postgres redis web
pnpm install
# .env: point the API at the compose-published ports
#   DATABASE_URL=postgresql://cloudops:cloudops@localhost:5432/cloudops?schema=public
#   REDIS_URL=redis://localhost:6379
pnpm --filter @cloudops/api db:migrate
pnpm --filter @cloudops/api prisma:seed
pnpm dev:api                       # API + workers on :3000
```

### 3. Verify

1. `curl http://localhost:3000/health/ready` should report `"status":"ok"` with the `database`
   and `redis` checks passing.
2. Sign in at http://localhost:5173.
3. Swagger at http://localhost:3000/api/docs lists every endpoint.
4. Run **Sync** on the dashboard. The run goes from queued to running to completed, with
   discovered, created, updated and deleted counts. Run it again: only real changes produce
   change events.

### Upgrading

```bash
git pull
docker compose up -d --build
```

The API container migrates the database on start:

- **Databases created by versions before versioned migrations** (the old `prisma db push`
  flow) are adopted automatically on the first boot. The schema is brought up to date
  additively (Prisma refuses any change that would lose data), the existing migrations are
  recorded as applied, and the database then continues as a normal migrated one. No data is
  modified. Back up first anyway (see [Backup & restore](#backup--restore)).
- Afterwards the live schema is compared with `schema.prisma`, and any drift is reported in the
  API log. Drift is never auto-fixed.

#### Behaviour changes in the platform-hardening release

- **Self-registration is closed.** Only admins create accounts (Settings → Users).
- **Resources that disappear from Azure are marked deleted** by the next sync, instead of staying
  "active" forever. The inventory shows active resources by default; switch the state filter to
  see deleted ones. Safety guards skip deletion when a subscription returns nothing or would
  lose more than half its resources.
- **Monthly cost per resource is now the trailing 30 days** ending at the latest cost date.
  Previously it summed the whole sync window (up to `FINOPS_WINDOW_DAYS`, default 90), which
  overstated it. Dashboard cost figures drop to the correct value after the next cost sync.
- **Postgres and Redis are published on `127.0.0.1` only.** A remote DB tool must go through
  an SSH tunnel.
- **The web container listens on 8080 internally**, as unprivileged nginx. Compose still
  publishes it on host port 5173.
- **In production, the API refuses to start with default or weak JWT secrets.**
- **Temporary passwords must be replaced.** This covers:
  - accounts an admin creates or resets
  - generated CLI resets
  - the seeded admin, and anyone signing in with the documented default password

  These users choose their own password at the next sign-in.

- **Per-resource cost figures are recomputed at start-up** from stored cost records. The
  corrected numbers appear on the first boot after upgrading, without waiting for a cost sync.
- **The dashboard's projected monthly cost now includes unattributed spend** (cost that matches no
  inventory resource), so it agrees with the FinOps total. A breakdown line shows how much is
  unattributed.
- **Refresh tokens are strictly single-use**, even for concurrent requests. The web app
  coordinates refreshes between tabs; other API clients must not refresh in parallel with the
  same token.

#### Behaviour changes in the inventory, standards and FinOps release

- **All cost is shown in INR** (`COST_CURRENCY`). Previously the symbol followed whichever billing
  account synced last, which could show `$` for rupee amounts. Subscriptions billed in another
  currency are converted at Microsoft's rate. The conversion of already-stored rows happens on the
  first start.
- **Sync matches resources case-insensitively.** Duplicates from before stay until an admin merges
  them (System status → Data integrity). The merge is manual on purpose, because it deletes rows.
- **Standards scores change:**
  - Rules now judge only the resources they apply to.
  - The cost-data rule only covers fixed-price resources, so web apps and pay-per-use services no
    longer fail it.
  - New built-in packs appear: Security Baseline, Cost Optimization, Reliability and Operations.
  - Existing rule switches are kept.
  - Run an evaluation after upgrading.
- **The dashboard's "projected monthly cost"** also counts cost on deleted-but-billing resources,
  matching FinOps.
- **Four new migrations**, all additive: cost currency columns, properties hash, standards v2 and
  exemptions, and budgets.

### Production checklist

Use this for anything beyond a single-user laptop:

- [ ] `NODE_ENV=production`
- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`: two **different** random values of at least
      32 characters, e.g. `openssl rand -base64 48`. The API will not boot otherwise.
- [ ] Change the seeded admin's password on first login, or set a strong `SEED_ADMIN_PASSWORD`
      before the first boot.
- [ ] Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front of the web (5173) and
      API (3000) ports, and don't expose them directly. Then:
  - [ ] `TRUST_PROXY=1` (the number of proxy hops), so rate limits and audit entries see the
        real client IP.
  - [ ] `VITE_API_BASE_URL=https://api.example.com`. It is baked into the web bundle at build
        time, so rebuild the web image after changing it.
  - [ ] `API_ORIGIN=https://api.example.com`, the origin the web CSP allows the browser to call.
  - [ ] `CORS_ORIGIN=https://cloudops.example.com`, the web origin(s) the API accepts.
- [ ] Change `POSTGRES_PASSWORD` (and `DATABASE_URL`) from the defaults.
- [ ] Keep Postgres and Redis unpublished, or on `127.0.0.1` as shipped. Redis has no password.
- [ ] `AZURE_ALLOW_WRITE=false` if the platform must be strictly read-only.
- [ ] Back up the `postgres_data` volume **and** the `cloudops_data` volume (it holds the
      credential store and its key). See [Backup & restore](#backup--restore).
- [ ] Point your orchestrator's probes at `/health/live` (liveness) and `/health/ready`
      (readiness).

### Scaling out workers

Workers run inside the API process by default. To run them separately, start another container
from the API image with the command `node --import tsx src/workers/main.ts` (working directory
`/app/apps/api`) and the same environment. Queues live in Redis, so any number of API and
worker processes share them. Enqueueing stays idempotent across processes: only one inventory sync is
queued or running at a time.

### Common operations

```bash
docker compose logs -f api            # API + worker logs (JSON)
docker compose restart api            # restart; in-flight jobs drain first (30s grace)
docker compose down                   # stop, keeping all data
docker compose down -v                # stop and DELETE all data (Postgres, Redis, credentials)
```

### Backup & restore

Two volumes hold state. Back up **both**:

| Volume          | Contents                                                                       |
| --------------- | ------------------------------------------------------------------------------ |
| `postgres_data` | Everything in the database                                                     |
| `cloudops_data` | The encrypted credential store, **its key file**, and the per-org CLI profiles |

```bash
# Postgres (consistent logical dump, safe while running)
docker compose exec -T postgres pg_dump -U cloudops -d cloudops -Fc > cloudops-$(date +%F).dump

# Credential store + key (tar the volume from a throwaway container)
docker run --rm -v cloudops-platform_cloudops_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/cloudops-data-$(date +%F).tgz -C /data .
```

Restore:

```bash
docker compose stop api
docker compose exec -T postgres pg_restore -U cloudops -d cloudops --clean --if-exists < cloudops-YYYY-MM-DD.dump
docker run --rm -v cloudops-platform_cloudops_data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/cloudops-data-YYYY-MM-DD.tgz -C /data"
docker compose start api
```

The data archive contains the key that decrypts the client secrets, so store it as a secret. If
you set `CREDENTIAL_STORE_KEY`, the key is not in the archive; keep it with your other secrets.

---

## Data model (ERD)

The authoritative schema is [apps/api/prisma/schema.prisma](../apps/api/prisma/schema.prisma).
This diagram summarizes the Phase-1 shape (extension tables included, forward-compatible).

```mermaid
erDiagram
  User ||--o{ UserRole : has
  Role ||--o{ UserRole : grants
  User ||--o{ Session : owns

  Provider ||--o{ ProviderConnection : "non-secret metadata"

  Tenant ||--o{ Subscription : contains
  Subscription ||--o{ ResourceGroup : contains
  Subscription ||--o{ Resource : contains
  ResourceGroup ||--o{ Resource : contains
  Resource ||--o{ ResourceRelationship : "source/target"
  Resource ||--o{ ResourceSnapshot : "history"
  Resource ||--o{ ChangeEvent : "change detection"
  Resource ||--o{ AssetLifecycleEvent : "lifecycle timeline"

  BusinessService ||--o{ ResourceServiceMap : maps
  Resource ||--o{ ResourceServiceMap : maps
  Environment ||--o{ ResourceEnvironmentMap : maps
  Resource ||--o{ ResourceEnvironmentMap : maps

  SyncRun ||--o{ ChangeEvent : produces

  Standard ||--o{ StandardRule : defines
  StandardRule ||--o{ ComplianceResult : evaluates

  Board ||--o{ BoardColumn : has
  BoardColumn ||--o{ WorkItem : holds
  Sprint ||--o{ WorkItem : plans
  WorkItem ||--o{ WorkItemLink : links
  WorkItem ||--o{ Comment : has
  WorkItem ||--o{ LabelOnWorkItem : tagged
  Label ||--o{ LabelOnWorkItem : tags

  Workspace ||--o{ Document : contains
```

### Design notes

- **`Resource`** is polymorphic across providers (`providerKey`, `type`, `sku`, `location`,
  `tags Json`, `properties Json`), soft-deleted via `state`, and carries a `lifecycleStage`.
- **External ids** are normalized (subscription = bare guid; resource-group id lowercased) so
  resource→scope linkage is deterministic across sync runs.
- **No secrets** live in any table; `ProviderConnection` holds connection metadata only.
- **Deletion is a state, not a row delete.** A resource no longer seen by a sync gets
  `state = deleted` (plus a `Deleted` lifecycle event), and keeps its history and cost. It is
  restored if it reappears. `SyncRun.deleted` counts flags per run.
- **Cost rollup.** `Resource.costMonthly` is the trailing-30-day sum of `CostRecord` ending at the
  latest cost date, and `costDaily` is that sum divided by 30. Both are recomputed after every
  cost sync and at API start.
- **Auth.** `Session` stores only a hash of each refresh token. `User.passwordChangedAt`
  invalidates access tokens issued earlier, and `User.lastLoginAt` is shown on the Users page.
  `User.mustChangePassword` marks a password someone else set (admin, CLI, seed); the user
  replaces it at next sign-in.
- **`AuditLog`** is append-only. It records the actor (`actorId` + display name), the action,
  the entity, secret-free metadata, the IP and the `requestId`, and is indexed for the admin audit
  view.
- **Schema changes** ship as versioned migrations in `apps/api/prisma/migrations`. See
  [Data & migrations](#data--migrations).
- Extension tables (`Recommendation`, `ExecutionRun`, `Score`, `Budget`, `Notification`,
  `SavedCommand`, `ResourceTemplate`, `AiMemory`, …) are added in their roadmap phases against
  these same scope keys.

```

---

## Provider plugin guide

Providers are the primary extension point. The first additional adapter is Google Cloud; AWS,
Kubernetes, Terraform and GitHub remain future integrations. New adapters use a package and plugin
registration, while provider-specific account forms and credentials are handled separately.

### Google Cloud setup

The GCP adapter provides read-only inventory and cloud insights, plus a deliberately narrow
Compute Engine operation: starting or stopping an inventoried VM. It does not sync cost data,
write tags, delete resources, open SSH sessions, or run arbitrary commands.

1. Enable the **Cloud Asset API**, **Cloud Resource Manager API**, **Security Command Center API**,
   **Cloud Monitoring API**, **Service Health API**, **Recommender API**, and **Compute Engine API**
   for the project.
2. Create a service account and grant it **Cloud Asset Viewer** (`roles/cloudasset.viewer`) and
   **Browser** (`roles/browser`) for inventory.
3. For insights, grant **Security Center Findings Viewer** (`roles/securitycenter.findingsViewer`),
   **Monitoring Viewer** (`roles/monitoring.viewer`), **IAM Security Reviewer**
   (`roles/iam.securityReviewer`), **Service Health Viewer** (`roles/servicehealth.viewer`) and
   **Recommender Viewer** (`roles/recommender.viewer`). The adapter reads active Security Command
   Center findings, 24-hour Compute Engine CPU utilization, project-level IAM bindings, service
   health events, and three Compute Engine recommendations (machine type, idle instance, and idle
   disk).
4. To enable VM start/stop, add a custom role with only `compute.instances.start` and
   `compute.instances.stop`, and grant it to the service account. Keep write access separate from
   the read-only roles where possible. CloudOps additionally requires the caller to hold
   `remediation.execute`; each operation is confirmed in the UI and recorded in the audit log.
5. Create a JSON key for that service account and keep the downloaded file private.
6. In CloudOps, open **Providers → Google Cloud → Add project**. Enter a display name, the GCP
   project ID, the service account email, and the full JSON key file contents. Select **Test
   credentials**, then save the project.
7. Start an inventory sync from **Sync center**, then open **Operations → Cloud insights** and
   select **Sync insights**. Each capability's data and any API/permission error are saved locally
   in CloudOps. Metrics are refreshed for the latest 24 hours.

The JSON key is stored in the local encrypted credential store, not in Postgres or audit logs.
Never paste it into chat or commit it to source control. Remove the key from CloudOps and revoke it
in Google Cloud when it is no longer needed.

### 1. Create the package

```

packages/provider-aws/
package.json # name: @cloudops/provider-aws, deps on core/kernel/provider-sdk/credentials
tsconfig.json # extends ../../tsconfig.base.json
src/
aws-provider.ts # implements CloudProvider
mappers.ts # normalize provider data → ResourceRecord / Scope
plugin.ts # kernel Plugin that registers into PROVIDER_REGISTRY
index.ts

````

### 2. Implement the `CloudProvider` contract

```ts
import type { CloudProvider, ProviderContext, Scope, ResourceRecord } from '@cloudops/provider-sdk';

export class AwsProvider implements CloudProvider {
  readonly key = 'aws';
  readonly displayName = 'Amazon Web Services';
  readonly capabilities = ['inventory'] as const;

  async testConnection(ctx: ProviderContext) { /* ... */ }
  async *discoverScopes(ctx: ProviderContext): AsyncIterable<Scope> { /* accounts → regions */ }
  async *discoverResources(scope: Scope, ctx: ProviderContext): AsyncIterable<ResourceRecord> { /* ... */ }
  async getResourceDetail(externalId: string, ctx: ProviderContext) { /* ... */ }
}
````

Return **normalized** records (`ResourceRecord`, `Scope`) with a globally-unique `externalId`.
The sync engine handles upserts, change detection, and lifecycle events for free.

### 3. Expose a kernel plugin

```ts
import type { Plugin } from '@cloudops/kernel';
import { PROVIDER_REGISTRY } from '@cloudops/provider-sdk';
import { AwsProvider } from './aws-provider.js';

export function createAwsPlugin(options = {}): Plugin {
  return {
    id: 'provider:aws',
    kind: 'provider',
    register(ctx) {
      ctx.container.resolve(PROVIDER_REGISTRY).register(new AwsProvider(options));
    },
  };
}
```

### 4. Register in the composition root

In `apps/api/src/composition.ts`, add **one line**:

```ts
await kernel.plugins.use(createAwsPlugin({/* options */}));
```

That's it. The provider appears in `/api/providers`, is syncable via `POST /api/sync` with
`{ "providerKey": "aws" }`, and its resources flow into the same inventory, dashboard, and (in
later phases) recommendations, scoring, and workspaces — with **zero changes** to the core.

### Credential sources

If the provider needs secrets, add a `CredentialProvider` implementation to
`packages/credentials` and include it in the chain. Secrets are resolved at runtime and **never**
persisted to Postgres.
