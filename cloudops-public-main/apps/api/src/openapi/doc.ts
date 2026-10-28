/**
 * Hand-authored OpenAPI 3.0 document served at /api/docs. Kept intentionally
 * lightweight for the skeleton; later phases can generate it from Zod schemas.
 */
export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'CloudOps Platform API',
    version: '0.1.0',
    description: [
      'Self-hosted, provider-agnostic Cloud Operations Command Center. Azure is the first provider; every read endpoint serves the local Postgres cache (offline-first) — only syncs and tag writes call Azure.',
      '',
      '**Auth.** `POST /api/auth/login` returns a short-lived access token (Bearer) and a rotating refresh token. Accounts are created by admins (`/api/users`).',
      '',
      '**Permissions.** Roles (`admin`, `operator`, `finops`, `security`, `viewer`) are bundles of named permissions (e.g. `remediation.approve`, `audit.read`); everyone reads the estate. Each write endpoint names the permission it needs.',
      '',
      '**Errors.** Every error is `{ "error": { "code", "message", "details?", "requestId" } }`. `code` is stable (e.g. `validation_error`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `invalid_json`, `internal_error`); quote `requestId` (also the `X-Request-Id` header) when reporting a problem.',
      '',
      '**Rate limits.** Sign-in, token refresh, syncs, connectivity tests, exports and admin writes are rate limited; a `429` carries `Retry-After` and `RateLimit-*` headers.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [
    { name: 'Auth' },
    { name: 'Providers' },
    { name: 'Inventory' },
    { name: 'Sync' },
    { name: 'FinOps' },
    { name: 'Topology' },
    { name: 'Views' },
    { name: 'Dashboard' },
    { name: 'Work' },
    { name: 'Workspaces' },
    { name: 'Standards' },
    { name: 'Search' },
    { name: 'Notifications' },
    { name: 'Remediation' },
    { name: 'Drift' },
    { name: 'Automation' },
    { name: 'Administration' },
    { name: 'Health' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', example: 'validation_error' },
              message: { type: 'string', example: 'Invalid request' },
              details: { description: 'Validation issues or other structured context' },
              requestId: { type: 'string', example: '0b7c5e1a-0000-4000-8000-00000000c0de' },
              retryAfterSeconds: { type: 'integer', description: 'Only on 429' },
            },
          },
        },
      },
    },
    responses: {
      Unauthorized: { description: 'Missing/invalid/expired token, or account disabled', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Forbidden: { description: 'Authenticated but lacking the required role', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      RateLimited: { description: 'Too many requests — see Retry-After', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      ValidationError: { description: 'Invalid request body/query', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: { tags: ['Health'], summary: 'Readiness (alias of /health/ready; kept for existing probes)', security: [], responses: { '200': { description: 'OK' }, '503': { description: 'A dependency is down' } } },
    },
    '/health/live': {
      get: { tags: ['Health'], summary: 'Liveness — the process is up', security: [], responses: { '200': { description: 'OK' } } },
    },
    '/health/ready': {
      get: { tags: ['Health'], summary: 'Readiness — Postgres and Redis reachable (per-check latency)', security: [], responses: { '200': { description: 'Ready' }, '503': { description: 'Degraded' } } },
    },
    '/api/auth/register': {
      post: { tags: ['Auth'], summary: 'Create a viewer account (admin only — self-registration is closed; prefer POST /api/users)', responses: { '201': { description: 'Created' }, '401': { $ref: '#/components/responses/Unauthorized' }, '403': { $ref: '#/components/responses/Forbidden' } } },
    },
    '/api/auth/login': {
      post: { tags: ['Auth'], summary: 'Sign in (returns access + refresh tokens). Rate limited per account and per IP. `user.mustChangePassword` is true when the password was set by an admin (or is the seeded default) — clients should require a password change.', security: [], responses: { '200': { description: 'OK' }, '401': { $ref: '#/components/responses/Unauthorized' }, '429': { $ref: '#/components/responses/RateLimited' } } },
    },
    '/api/auth/refresh': {
      post: { tags: ['Auth'], summary: 'Rotate tokens. The presented refresh token is strictly single-use: of concurrent requests with the same token exactly one succeeds (clients sharing storage across tabs must serialize refreshes).', security: [], responses: { '200': { description: 'OK' }, '401': { $ref: '#/components/responses/Unauthorized' } } },
    },
    '/api/auth/logout': {
      post: { tags: ['Auth'], summary: 'Revoke the session behind a refresh token (idempotent)', security: [], responses: { '204': { description: 'Signed out' } } },
    },
    '/api/auth/password': {
      post: { tags: ['Auth'], summary: 'Change your own password — revokes all other sessions and returns a fresh one', responses: { '200': { description: 'OK — LoginResponse' }, '400': { $ref: '#/components/responses/ValidationError' } } },
    },
    '/api/users': {
      get: { tags: ['Administration'], summary: 'List users (admin)', responses: { '200': { description: 'OK — AdminUserDto[]' }, '403': { $ref: '#/components/responses/Forbidden' } } },
      post: { tags: ['Administration'], summary: 'Create a user with roles (admin)', responses: { '201': { description: 'Created' }, '400': { $ref: '#/components/responses/ValidationError' }, '409': { description: 'Email already exists' } } },
    },
    '/api/users/{id}': {
      patch: { tags: ['Administration'], summary: 'Update name / roles / active (admin). Guards: no self-lockout; at least one active admin.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '409': { description: 'Would lock out the last admin or yourself' } } },
    },
    '/api/users/{id}/reset-password': {
      post: { tags: ['Administration'], summary: 'Set a new password and sign the user out everywhere (admin)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Reset' } } },
    },
    '/api/audit': {
      get: {
        tags: ['Administration'],
        summary: 'Audit trail — who did what, when, to what, from where (admin)',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer' } },
          { name: 'pageSize', in: 'query', schema: { type: 'integer', maximum: 200 } },
          { name: 'action', in: 'query', description: 'Action prefix, e.g. auth.', schema: { type: 'string' } },
          { name: 'entity', in: 'query', schema: { type: 'string' } },
          { name: 'entityId', in: 'query', schema: { type: 'string' } },
          { name: 'actorId', in: 'query', schema: { type: 'string' } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': { description: 'OK — Paginated<AuditLogDto>' } },
      },
    },
    '/api/audit/actions': { get: { tags: ['Administration'], summary: 'Distinct audit action names (admin)', responses: { '200': { description: 'OK' } } } },
    '/api/system/duplicates': {
      get: { tags: ['Administration'], summary: 'Resources stored more than once (same Azure id, different letter case): which row is kept and what would move (admin).', responses: { '200': { description: 'OK — DuplicatePreviewDto' } } },
    },
    '/api/system/duplicates/merge': {
      post: { tags: ['Administration'], summary: 'Merge duplicate resource rows: cost, history, relationships, links, docs and exemptions move to the kept row; the others are deleted. Irreversible (admin, audited).', responses: { '200': { description: 'OK — { groups, rowsRemoved }' } } },
    },
    '/api/standards/library': {
      get: { tags: ['Standards'], summary: 'The rule library: every rule, what it checks, where it applies, its parameters and how to fix a failure.', responses: { '200': { description: 'OK — RuleTemplateDto[]' } } },
    },
    '/api/standards/rules/preview': {
      post: { tags: ['Standards'], summary: 'Dry-run a rule (library template + params, or conditions) with an optional scope against the current inventory. Nothing is saved (admin/operator).', responses: { '200': { description: 'OK — RulePreviewDto' }, '400': { $ref: '#/components/responses/ValidationError' } } },
    },
    '/api/standards/exemptions': {
      get: { tags: ['Standards'], summary: 'Exemptions (accepted exceptions), filterable by ruleId / resourceId.', responses: { '200': { description: 'OK — ExemptionDto[]' } } },
      post: { tags: ['Standards'], summary: 'Exempt a resource from a rule, with a reason and optional end date — excluded from scoring (admin/operator, audited).', responses: { '201': { description: 'Created — ExemptionDto' }, '404': { description: 'Unknown rule or resource' } } },
    },
    '/api/standards/exemptions/{id}': {
      delete: { tags: ['Standards'], summary: 'Remove an exemption (admin/operator, audited).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/api/inventory/resources/groups': {
      get: { tags: ['Inventory'], summary: 'The filtered inventory grouped by organization, subscription, resourceGroup, category, type, location or owner — counts, 30-day cost and the filter selecting each group. Accepts every /resources filter plus groupBy.', responses: { '200': { description: 'OK — InventoryGroupsDto' } } },
    },
    '/api/inventory/tree': {
      get: { tags: ['Inventory'], summary: 'Organization → subscription → resource group with resource counts (the scope navigator). ?states=active,deleted', responses: { '200': { description: 'OK — InventoryTreeDto' } } },
    },
    '/api/finops/coverage': {
      get: { tags: ['FinOps'], summary: 'Cost data coverage per subscription: the latest day with stored cost, and its result in the most recent cost sync (updated / no data / disabled / throttled / network / no access / unsupported / unconverted / error) with the reason.', responses: { '200': { description: 'OK — CostCoverageDto[]' } } },
    },
    '/api/finops/overview': {
      get: { tags: ['FinOps'], summary: 'This month (to date, same point last month, forecast, run-rate), spend outside the inventory (deleted / not in inventory / subscription-level), savings opportunities and budget status. ?tenantId= | ?subscriptionId=', responses: { '200': { description: 'OK — FinopsOverviewDto' } } },
    },
    '/api/finops/budgets': {
      post: { tags: ['FinOps'], summary: 'Create a monthly budget for all spend, an organization, a subscription or a resource group (admin/operator, audited).', responses: { '201': { description: 'Created' }, '400': { $ref: '#/components/responses/ValidationError' } } },
    },
    '/api/finops/budgets/{id}': {
      put: { tags: ['FinOps'], summary: 'Update a budget (admin/operator).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      delete: { tags: ['FinOps'], summary: 'Delete a budget (admin/operator).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Deleted' } } },
    },
    '/api/system/status': {
      get: {
        tags: ['Administration'],
        summary: 'On-call status (admin): Postgres/Redis latency, job-queue depths and connected workers, applied/pending migrations, last sync runs, effective settings. Every probe is time-bounded, so it answers during an outage.',
        responses: { '200': { description: 'OK — SystemStatusDto' }, '403': { $ref: '#/components/responses/Forbidden' } },
      },
    },
    '/api/auth/me': { get: { tags: ['Auth'], summary: 'Current user', responses: { '200': { description: 'OK' } } } },
    '/api/providers': { get: { tags: ['Providers'], summary: 'List registered provider plugins', responses: { '200': { description: 'OK' } } } },
    '/api/providers/{key}/test-connection': {
      get: { tags: ['Providers'], summary: 'Test provider connectivity (primary account)', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/api/providers/{key}/test': {
      get: { tags: ['Providers'], summary: 'Test every configured account/org (per-org read-access status)', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/api/providers/{key}/accounts': {
      get: { tags: ['Providers'], summary: 'List the organizations/accounts a provider syncs (secrets redacted)', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      post: { tags: ['Providers'], summary: 'Add an organization (admin) — stored in the local encrypted credential store, never in Postgres', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'Created' } } },
    },
    '/api/providers/{key}/accounts/status': {
      get: { tags: ['Providers'], summary: 'Where credentials come from (store vs .env vs host az login)', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/api/providers/{key}/accounts/test': {
      post: { tags: ['Providers'], summary: 'Validate credentials before saving them (admin)', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/api/providers/{key}/accounts/{id}': {
      patch: { tags: ['Providers'], summary: 'Update an organization (admin); omit clientSecret to keep the stored one', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      delete: { tags: ['Providers'], summary: 'Remove an organization and its stored secret (admin)', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Deleted' } } },
    },
    '/api/providers/{key}/accounts/{id}/test': {
      post: { tags: ['Providers'], summary: 'Validate one saved organization (admin)', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/api/inventory/resources': {
      get: {
        tags: ['Inventory'],
        summary: 'List/filter/search resources (paginated)',
        parameters: [
          { name: 'search', in: 'query', description: 'Fuzzy search (pg_trgm-accelerated ILIKE) across name/type/id/owner', schema: { type: 'string' } },
          { name: 'tenantId', in: 'query', description: 'Filter by organization (Tenant db id)', schema: { type: 'string' } },
          { name: 'subscriptionId', in: 'query', schema: { type: 'string' } },
          { name: 'resourceGroupId', in: 'query', schema: { type: 'string' } },
          { name: 'types', in: 'query', description: 'Multi-select (comma-separated) resource types', schema: { type: 'string' } },
          { name: 'locations', in: 'query', description: 'Multi-select (comma-separated) locations', schema: { type: 'string' } },
          { name: 'owners', in: 'query', description: 'Multi-select (comma-separated) owners', schema: { type: 'string' } },
          { name: 'subscriptionIds', in: 'query', description: 'Multi-select (comma-separated) subscription db ids', schema: { type: 'string' } },
          { name: 'lifecycleStages', in: 'query', description: 'Multi-select (comma-separated) lifecycle stages', schema: { type: 'string' } },
          { name: 'states', in: 'query', description: 'Multi-select (comma-separated) states', schema: { type: 'string' } },
          { name: 'tags', in: 'query', description: "Tag filters, comma-separated 'key:value' (AND-combined)", schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
          { name: 'pageSize', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/inventory/resources/facets': { get: { tags: ['Inventory'], summary: 'Distinct filter facets (types, locations, orgs, owners, lifecycle, subscriptions, tag keys)', responses: { '200': { description: 'OK' } } } },
    '/api/inventory/resources/{id}': {
      get: { tags: ['Inventory'], summary: 'Resource detail + relationships', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/api/inventory/resources/{id}/history': {
      get: { tags: ['Inventory'], summary: 'Resource lifecycle timeline + change history', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/api/inventory/organizations': { get: { tags: ['Inventory'], summary: 'List organizations (Entra tenants) with sub/RG/resource rollups', parameters: [{ name: 'tenantId', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/inventory/subscriptions': { get: { tags: ['Inventory'], summary: 'List subscriptions (with organization attribution)', parameters: [{ name: 'tenantId', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/inventory/resource-groups': { get: { tags: ['Inventory'], summary: 'List resource groups (optionally by subscription / organization). Includes 7-day daily cost + tags.', parameters: [{ name: 'subscriptionId', in: 'query', schema: { type: 'string' } }, { name: 'tenantId', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/inventory/resources/{id}/tags': { put: { tags: ['Inventory'], summary: 'Set the full tag set on a resource — writes back to Azure (admin/operator; falls back to CloudOps-only for untaggable types). At most 50 tags; names ≤ 512 chars, not starting with "-", without < > % & \\ ? / =.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK — TagWriteResult' } } } },
    '/api/inventory/resource-groups/{id}/tags': { put: { tags: ['Inventory'], summary: 'Apply (merge) tags onto a resource group and every resource in it, synchronously (admin/operator). Prefer the job endpoint for large groups.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK — ResourceGroupTagResult' } } } },
    '/api/inventory/resource-groups/{id}/tags/jobs': { post: { tags: ['Inventory'], summary: 'Start a background tag job for a resource group (admin/operator). One job per RG at a time — a duplicate request returns the running job (deduplicated: true).', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '202': { description: 'Accepted — TagJobDto' } } } },
    '/api/inventory/tag-jobs/{jobId}': { get: { tags: ['Inventory'], summary: 'Tag job status + progress { done, total } + result', parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK — TagJobDto' }, '404': { description: 'Unknown/expired job' } } } },
    '/api/inventory/resources/export.csv': { get: { tags: ['Inventory'], summary: 'CSV export of every resource matching the /resources filters (streamed, up to 50,000 rows; formula-injection safe)', responses: { '200': { description: 'text/csv attachment' }, '429': { $ref: '#/components/responses/RateLimited' } } } },
    '/api/sync/azure': { post: { tags: ['Sync'], summary: 'Enqueue an Azure inventory sync (admin/operator). Idempotent: while a sync is queued/running, that run is returned with deduplicated: true. 503 service_unavailable (immediately, nothing created) when the job queue (Redis) is down.', responses: { '202': { description: 'Accepted — SyncRunDto' }, '403': { $ref: '#/components/responses/Forbidden' }, '429': { $ref: '#/components/responses/RateLimited' }, '503': { description: 'Job queue unavailable' } } } },
    '/api/sync/runs': { get: { tags: ['Sync'], summary: 'Sync run history', responses: { '200': { description: 'OK' } } } },
    '/api/finops/sync': { post: { tags: ['FinOps'], summary: 'Enqueue a cost sync (Cost Management via az rest). Idempotent while one is waiting/running.', responses: { '202': { description: 'Accepted' } } } },
    '/api/finops/query': {
      get: {
        tags: ['FinOps'],
        summary: 'Cost explorer: range/granularity/groupBy + scope filters + period-over-period compare',
        parameters: [
          { name: 'preset', in: 'query', schema: { type: 'string', enum: ['1d', '7d', '30d', '90d', 'custom'] } },
          { name: 'from', in: 'query', description: 'YYYY-MM-DD (custom)', schema: { type: 'string' } },
          { name: 'to', in: 'query', description: 'YYYY-MM-DD (custom, inclusive)', schema: { type: 'string' } },
          { name: 'granularity', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'] } },
          { name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['organization', 'subscription', 'resourceGroup', 'resource', 'service', 'category', 'owner', 'tag'] } },
          { name: 'tagKey', in: 'query', description: 'With groupBy=tag: the tag whose values split the cost (showback)', schema: { type: 'string' } },
          { name: 'tenantId', in: 'query', schema: { type: 'string' } },
          { name: 'subscriptionId', in: 'query', schema: { type: 'string' } },
          { name: 'resourceGroupId', in: 'query', schema: { type: 'string' } },
          { name: 'resourceId', in: 'query', schema: { type: 'string' } },
          { name: 'compare', in: 'query', schema: { type: 'boolean' } },
          { name: 'compareFrom', in: 'query', description: 'Custom baseline start YYYY-MM-DD', schema: { type: 'string' } },
          { name: 'compareTo', in: 'query', description: 'Custom baseline end YYYY-MM-DD (inclusive)', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/finops/resources/{id}/trend': { get: { tags: ['FinOps'], summary: 'Daily cost trend for one resource', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/topology': {
      get: {
        tags: ['Topology'],
        summary: 'Dependency graph (nodes + typed edges) for a scope, incl. connected out-of-scope neighbours',
        parameters: [
          { name: 'tenantId', in: 'query', description: 'Filter by organization (Tenant db id)', schema: { type: 'string' } },
          { name: 'subscriptionId', in: 'query', schema: { type: 'string' } },
          { name: 'resourceGroupId', in: 'query', schema: { type: 'string' } },
          { name: 'type', in: 'query', description: 'Filter by Azure resource type', schema: { type: 'string' } },
          { name: 'limit', in: 'query', description: 'Max in-scope nodes before truncation', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/views': {
      get: {
        tags: ['Views'],
        summary: 'List saved views for an explorer',
        parameters: [{ name: 'scope', in: 'query', schema: { type: 'string', default: 'inventory' } }],
        responses: { '200': { description: 'OK' } },
      },
      post: { tags: ['Views'], summary: 'Create a saved view (name + serialized filters)', responses: { '201': { description: 'Created' } } },
    },
    '/api/views/{id}': {
      put: { tags: ['Views'], summary: 'Rename / update a saved view', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      delete: { tags: ['Views'], summary: 'Delete a saved view', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'No Content' } } },
    },
    '/api/dashboard/summary': { get: { tags: ['Dashboard'], summary: 'Executive KPIs + breakdowns', parameters: [{ name: 'tenantId', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/dashboard/overview': { get: { tags: ['Dashboard'], summary: 'Operations Command Center — health, cost, compliance, work, insights, drift', parameters: [{ name: 'tenantId', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/work/items': {
      get: {
        tags: ['Work'],
        summary: 'List work items (filter by state/type/assignee/scope/org/search)',
        parameters: [
          { name: 'state', in: 'query', schema: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] } },
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'assignee', in: 'query', schema: { type: 'string' } },
          { name: 'scopeType', in: 'query', schema: { type: 'string', enum: ['organization', 'subscription', 'resourceGroup', 'resource'] } },
          { name: 'scopeId', in: 'query', schema: { type: 'string' } },
          { name: 'tenantId', in: 'query', description: 'Org scoping — items linked to this tenant or anything under it', schema: { type: 'string' } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
      post: { tags: ['Work'], summary: 'Create a work item (optionally scoped to an entity; supports recurrence)', responses: { '201': { description: 'Created' } } },
    },
    '/api/work/summary': { get: { tags: ['Work'], summary: 'Work-item counts by state + overdue (scope/org aware)', responses: { '200': { description: 'OK' } } } },
    '/api/work/items/{id}': {
      get: { tags: ['Work'], summary: 'Work item detail + comments', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      patch: { tags: ['Work'], summary: 'Update a work item (completing a recurring item spawns the next)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      delete: { tags: ['Work'], summary: 'Delete a work item', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'No Content' } } },
    },
    '/api/work/items/{id}/comments': {
      post: { tags: ['Work'], summary: 'Add a comment (author = current user)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'Created' } } },
    },
    '/api/workspaces': { get: { tags: ['Workspaces'], summary: 'List all resource workspaces (index)', responses: { '200': { description: 'OK' } } } },
    '/api/workspaces/scope/{scopeType}/{scopeId}': {
      get: {
        tags: ['Workspaces'],
        summary: 'Workspace + documents for a scope (null until the first doc)',
        parameters: [
          { name: 'scopeType', in: 'path', required: true, schema: { type: 'string', enum: ['organization', 'subscription', 'resourceGroup', 'resource'] } },
          { name: 'scopeId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/workspaces/scope/{scopeType}/{scopeId}/documents': {
      post: {
        tags: ['Workspaces'],
        summary: 'Create a markdown document under a scope (auto-creates the workspace)',
        parameters: [
          { name: 'scopeType', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'scopeId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '201': { description: 'Created' } },
      },
    },
    '/api/workspaces/documents/{id}': {
      get: { tags: ['Workspaces'], summary: 'Get a document', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      patch: { tags: ['Workspaces'], summary: 'Update a document (title/kind/body)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      delete: { tags: ['Workspaces'], summary: 'Delete a document', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'No Content' } } },
    },
    '/api/standards': { get: { tags: ['Standards'], summary: 'Compliance summary — per-standard/per-rule scores', responses: { '200': { description: 'OK' } } } },
    '/api/standards/evaluate': { post: { tags: ['Standards'], summary: 'Re-evaluate every rule against every resource (admin/operator)', responses: { '200': { description: 'OK' } } } },
    '/api/standards/custom': { post: { tags: ['Standards'], summary: 'Create a custom standard (admin/operator)', responses: { '201': { description: 'Created — returns fresh summary' } } } },
    '/api/standards/custom/{id}': { delete: { tags: ['Standards'], summary: 'Delete a custom standard + its rules (admin/operator)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/standards/{standardId}/rules': { post: { tags: ['Standards'], summary: 'Add a declarative rule to a custom standard (admin/operator)', parameters: [{ name: 'standardId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'Created' } } } },
    '/api/standards/rules/{id}': {
      patch: { tags: ['Standards'], summary: 'Edit a custom rule, or toggle a built-in rule enabled (admin/operator)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      delete: { tags: ['Standards'], summary: 'Delete a custom rule (admin/operator)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/api/standards/results': {
      get: {
        tags: ['Standards'],
        summary: 'Drilldown: resources passing/failing a rule',
        parameters: [
          { name: 'ruleId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'passed', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/standards/resources/{id}': { get: { tags: ['Standards'], summary: 'Per-resource compliance (Compliance tab)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    // ── Operations platform ──
    '/api/search': { get: { tags: ['Search'], summary: 'Global search across resources, groups, subscriptions, organizations, work, documents, rules and runs — by name, id, tag key=value or IP', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }, { name: 'kinds', in: 'query', schema: { type: 'string' }, description: 'Comma-separated kinds' }], responses: { '200': { description: 'OK — SearchResponseDto' }, '429': { $ref: '#/components/responses/RateLimited' } } } },
    '/api/notifications': { get: { tags: ['Notifications'], summary: 'Your notifications (cursor-paged; filtered by your permissions)', responses: { '200': { description: 'OK — NotificationListDto' } } } },
    '/api/notifications/unread-count': { get: { tags: ['Notifications'], summary: 'Unread count for the bell', responses: { '200': { description: 'OK' } } } },
    '/api/notifications/read': { post: { tags: ['Notifications'], summary: 'Mark notifications read', responses: { '204': { description: 'No Content' } } } },
    '/api/notifications/read-all': { post: { tags: ['Notifications'], summary: 'Mark everything read', responses: { '204': { description: 'No Content' } } } },
    '/api/remediation/actions': { get: { tags: ['Remediation'], summary: 'The action catalog: what CloudOps can change, risk, reversibility, availability', responses: { '200': { description: 'OK' } } } },
    '/api/remediation/plan': { post: { tags: ['Remediation'], summary: 'Dry run: targets, current → desired values, the exact provider calls, what is skipped and why. Changes nothing.', responses: { '200': { description: 'OK — RemediationPlanDto' } } } },
    '/api/remediation/runs': {
      get: { tags: ['Remediation'], summary: 'Remediation runs (filter by status)', responses: { '200': { description: 'OK' } } },
      post: { tags: ['Remediation'], summary: 'Request a remediation (remediation.request). Medium/high risk waits for a second person to approve.', responses: { '201': { description: 'Created' }, '403': { $ref: '#/components/responses/Forbidden' } } },
    },
    '/api/remediation/runs/{id}': { get: { tags: ['Remediation'], summary: 'Run detail: targets, per-target results and verification, what you may do next', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/remediation/runs/{id}/decision': { post: { tags: ['Remediation'], summary: 'Approve or reject (remediation.approve; not the requester for medium/high risk)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '403': { $ref: '#/components/responses/Forbidden' } } } },
    '/api/remediation/runs/{id}/execute': { post: { tags: ['Remediation'], summary: 'Run an approved remediation in the background (remediation.execute; needs provider writes enabled)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Queued' } } } },
    '/api/remediation/runs/{id}/cancel': { post: { tags: ['Remediation'], summary: 'Cancel before it starts (requester or approver)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/sync/runs/{id}': { get: { tags: ['Sync'], summary: 'One sync run (Sync center detail)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/sync/runs/{id}/cancel': { post: { tags: ['Sync'], summary: 'Cancel a queued sync (inventory.sync). A running sync finishes.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '409': { description: 'Already running or finished' } } } },
    '/api/drift': { get: { tags: ['Drift'], summary: 'Detected configuration changes (field, before → after, when, which sync), with per-field counts', responses: { '200': { description: 'OK — DriftListDto' } } } },
    '/api/drift/{id}/activity': { get: { tags: ['Drift'], summary: 'Who made a change: the provider activity log in the week before detection (read-only; unavailable reasons are explained)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK — DriftActivityDto' } } } },
    '/api/automation/rules': {
      get: { tags: ['Automation'], summary: 'Automation rules (trigger → conditions → actions) with their last run', responses: { '200': { description: 'OK' } } },
      post: { tags: ['Automation'], summary: 'Create a rule (automation.manage). Actions notify and raise work — never change the cloud.', responses: { '201': { description: 'Created' } } },
    },
    '/api/automation/rules/{id}': {
      put: { tags: ['Automation'], summary: 'Replace a rule (automation.manage)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      delete: { tags: ['Automation'], summary: 'Delete a rule (automation.manage)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'No Content' } } },
    },
    '/api/automation/rules/{id}/run': { post: { tags: ['Automation'], summary: 'Run a rule now against today’s data (automation.manage); recorded like any run', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK — AutomationRunDto' } } } },
    '/api/automation/preview': { post: { tags: ['Automation'], summary: 'What a (draft) rule would match with today’s data — changes nothing', responses: { '200': { description: 'OK — AutomationPreviewDto' } } } },
    '/api/automation/runs': { get: { tags: ['Automation'], summary: 'Run history (what matched, what each action did)', responses: { '200': { description: 'OK' } } } },
    '/api/auth/sessions': { get: { tags: ['Auth'], summary: 'Your signed-in devices', responses: { '200': { description: 'OK — SessionDto[]' } } } },
    '/api/auth/sessions/{id}/revoke': { post: { tags: ['Auth'], summary: 'Sign out one of your other devices (it can’t renew; locked out within the access-token lifetime)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'No Content' } } } },
    '/api/auth/sessions/revoke-others': { post: { tags: ['Auth'], summary: 'Sign out every other device immediately; returns a fresh session for this one', responses: { '200': { description: 'OK — LoginResponse' } } } },
    '/api/users/{id}/sessions': { get: { tags: ['Administration'], summary: 'A user’s signed-in devices (users.manage)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/users/{id}/sign-out': { post: { tags: ['Administration'], summary: 'Sign a user out everywhere, immediately (users.manage)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'No Content' } } } },
    '/api/audit/actors': { get: { tags: ['Administration'], summary: 'People in the audit log (for the actor filter)', responses: { '200': { description: 'OK' } } } },
    '/api/audit/export': { get: { tags: ['Administration'], summary: 'CSV of the filtered audit log (newest 10,000; formula-injection safe; the export itself is audited)', responses: { '200': { description: 'text/csv attachment; X-Export-Truncated header' }, '429': { $ref: '#/components/responses/RateLimited' } } } },
    '/api/system/queues/{name}/jobs': { get: { tags: ['Administration'], summary: 'Jobs in a queue by state (system.read); payloads are secret-free', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, { name: 'state', in: 'query', schema: { type: 'string', enum: ['failed', 'active', 'waiting', 'delayed', 'completed'] } }], responses: { '200': { description: 'OK' } } } },
    '/api/system/queues/{name}/jobs/{id}': { get: { tags: ['Administration'], summary: 'Job detail: error, stack, result', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/system/queues/{name}/jobs/{id}/retry': { post: { tags: ['Administration'], summary: 'Retry a failed job (system.manage; never remediations)', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/system/queues/{name}/jobs/{id}/remove': { post: { tags: ['Administration'], summary: 'Remove a job that isn’t running (system.manage)', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'No Content' } } } },
    '/api/workspaces/documents/{id}/revisions': { get: { tags: ['Workspaces'], summary: 'Earlier versions of a document, with their authors', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/api/workspaces/documents/{id}/revisions/{revisionId}/restore': { post: { tags: ['Workspaces'], summary: 'Restore a version (docs.manage); the current one becomes a revision', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'revisionId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
    '/metrics': { get: { tags: ['Health'], summary: 'Prometheus metrics — only when METRICS_TOKEN is set; send it as a Bearer token', security: [], responses: { '200': { description: 'text/plain; version=0.0.4' }, '401': { description: 'Wrong or missing token' }, '404': { description: 'Metrics disabled' } } } },
  },
} as const;
