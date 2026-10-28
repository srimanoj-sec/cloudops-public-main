import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AccountCredentials,
  ActivityEntry,
  CloudProvider,
  ConnResult,
  CostQuery,
  ProviderAction,
  ProviderContext,
  ProviderCostRecord,
  ResourceDetail,
  ResourceRecord,
  Scope,
} from '@cloudops/provider-sdk';
import type { AccountConnResult, ProviderCapability } from '@cloudops/core';
import { az, AzError, type AzExecOptions } from './az-exec.js';

/**
 * Command groups this provider is allowed to invoke. Read-only inventory groups
 * plus `login` (needed only for the service-principal bootstrap in container/CI
 * mode). Interactive host mode reuses an existing `az login` and never logs in.
 */
const AZURE_PROVIDER_GROUPS = new Set([
  'account',
  'group',
  'resource',
  'graph',
  'rest', // Cost Management query API (FinOps)
  'monitor', // activity log (who changed a resource) — read only
  'version',
  'login',
]);

/** Groups a write path may use on top of the read set: tags, VM power. */
const AZURE_WRITE_GROUPS = ['tag', 'vm'];

/** Property paths an action may set (`networkAcls.defaultAction`, `httpsOnly`…). */
const PROPERTY_PATH = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*){0,4}$/;
/** Long-running writes (VM deallocate, deletes) outlive the default timeout. */
const ACTION_TIMEOUT_MS = 10 * 60_000;

/** The `az` argument vector for an action (no `az`, no output flag). */
export function actionArgs(action: ProviderAction): string[] {
  switch (action.kind) {
    case 'set-property': {
      if (!PROPERTY_PATH.test(action.path)) throw new AzError(`Refusing to set an unexpected property path "${action.path}"`, 'FORBIDDEN');
      const value = typeof action.value === 'string' ? action.value : String(action.value);
      if (/[\s"'`]/.test(value)) throw new AzError('Refusing a property value containing spaces or quotes', 'FORBIDDEN');
      return [
        'resource',
        'update',
        '--ids',
        action.externalId,
        '--set',
        `properties.${action.path}=${value}`,
        ...(action.apiVersion ? ['--api-version', action.apiVersion] : []),
        '--only-show-errors',
      ];
    }
    case 'power':
      if (!/\/providers\/microsoft\.compute\/virtualmachines\/[^/]+$/i.test(action.externalId)) {
        throw new AzError('Power operations apply to virtual machines only', 'FORBIDDEN');
      }
      return ['vm', action.operation === 'stop' ? 'deallocate' : action.operation, '--ids', action.externalId, '--only-show-errors'];
    case 'delete':
      return ['resource', 'delete', '--ids', action.externalId, '--only-show-errors'];
  }
}
import {
  DEFAULT_OWNER_TAG,
  mapGraphResource,
  mapResource,
  mapResourceGroup,
  mapSubscription,
  type AzResource,
  type AzResourceGroup,
  type AzSubscription,
} from './mappers.js';
import { queryResources } from './graph.js';
import { queryCost, toCostQueryError } from './cost.js';

/** An Azure org = one Entra tenant + its service principal. Secrets stay in memory. */
export interface AzureAccount {
  name: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface AzureProviderOptions {
  /** Azure CLI config dir for HOST mode (the operator's own `az login`). */
  configDir?: string;
  /**
   * Root directory for the per-organization Azure CLI profiles used in
   * multi-org mode — one isolated profile per service principal. Keep it on
   * private, persistent storage (the platform data dir): the CLI caches the SP
   * credential inside each profile. Default: `<os tmpdir>/cloudops-az-profiles`.
   */
  profilesDir?: string;
  /**
   * Multi-org service principals. Empty = host mode (reuse existing `az login`).
   * Pass a function when accounts are editable at runtime (Providers page): it is
   * re-read on every use, so added/edited/removed orgs take effect immediately —
   * no restart, and no secret ever leaves memory.
   */
  accounts?: AzureAccount[] | (() => AzureAccount[]);
  /** Restrict discovery to a single subscription id (optional). */
  subscriptionFilter?: string;
  /** Tag name to read the resource owner from (default `Owner`). */
  ownerTag?: string;
  /** Enable write-back to Azure (tag writes). Advertises the `tags` capability. */
  writeEnabled?: boolean;
}

/** Subscription GUID embedded in an ARM resource/RG id. */
function subscriptionOf(externalId: string): string | null {
  const m = /\/subscriptions\/([^/]+)/i.exec(externalId);
  return m ? m[1]! : null;
}

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/** Discovery re-logs in to refresh an org's subscription list at most this often. */
const SESSION_REFRESH_MS = 10 * 60 * 1000;

/** Stable, non-secret directory name for one org's CLI profile. */
function profileKey(account: Pick<AzureAccount, 'tenantId' | 'clientId'>): string {
  return `sp-${sha(`${account.tenantId.toLowerCase()}\u0000${account.clientId.toLowerCase()}`).slice(0, 20)}`;
}

/** A logged-in (or logging-in) org profile. */
interface OrgSession {
  /** Hash of the secret the session was created with — a rotation forces a re-login. */
  secretHash: string;
  /** When the login started (ms epoch) — bounds how stale a discovery listing can be. */
  createdAt: number;
  /** Resolves to the subscriptions that login surfaced. Shared by concurrent callers. */
  ready: Promise<AzSubscription[]>;
}

/**
 * Azure implementation of the CloudProvider contract.
 *
 * Two auth modes:
 *  - **Host mode** (`accounts` empty): reuse the ambient interactive `az login`.
 *  - **Multi-org mode** (`accounts` set): one service principal per Entra tenant,
 *    each in its OWN isolated Azure CLI profile (`AZURE_CONFIG_DIR` per org).
 *    There is no shared "active tenant": inventory sync, cost sync and tag
 *    writes can run concurrently across orgs without logging each other out or
 *    querying a subscription under the wrong tenant's session. Each org logs in
 *    once (deduplicated across concurrent callers) and re-authenticates only
 *    when its secret changes or its session is rejected. Secrets are used in
 *    memory; the only on-disk copy is the CLI's own token cache inside the
 *    org's private profile, which is deleted when the org is removed.
 */
export class AzureProvider implements CloudProvider {
  readonly key = 'azure';
  readonly displayName = 'Microsoft Azure';
  readonly capabilities: ProviderCapability[];

  private readonly subToAccount = new Map<string, AzureAccount>();
  /** Subscriptions already claimed this run — dedupes cross-tenant visibility. */
  private readonly seenSubs = new Set<string>();
  /** Live org sessions, keyed by profile key. */
  private readonly sessions = new Map<string, OrgSession>();
  /** Fingerprint of the account list the caches above were built from. */
  private accountsSignature?: string;

  constructor(private readonly options: AzureProviderOptions = {}) {
    // Write capabilities (`tags`, `actions`) are advertised only when write-back is enabled.
    this.capabilities = options.writeEnabled
      ? ['inventory', 'relationships', 'cost', 'activity', 'tags', 'actions']
      : ['inventory', 'relationships', 'cost', 'activity'];
  }

  /**
   * The orgs to sync, re-read on every access so runtime credential edits apply
   * without a restart. When the set changes, cached state is dropped and the
   * profiles of orgs that no longer exist are deleted (they hold a cached SP
   * credential). Sessions of unchanged orgs survive — no needless re-login.
   */
  private get accounts(): AzureAccount[] {
    const source = this.options.accounts;
    const list = typeof source === 'function' ? source() : (source ?? []);
    const signature = sha(list.map((a) => `${a.tenantId}\u0000${a.clientId}\u0000${a.clientSecret}`).join('\u0001'));
    if (signature !== this.accountsSignature) {
      const firstRead = this.accountsSignature === undefined;
      this.accountsSignature = signature;
      this.subToAccount.clear();
      this.seenSubs.clear();
      const live = new Set(list.map(profileKey));
      for (const key of this.sessions.keys()) if (!live.has(key)) this.sessions.delete(key);
      if (!firstRead || list.length > 0) void this.pruneProfiles(live);
    }
    return list;
  }

  private get ownerTag(): string {
    return this.options.ownerTag ?? DEFAULT_OWNER_TAG;
  }

  private get profilesRoot(): string {
    return this.options.profilesDir ?? join(tmpdir(), 'cloudops-az-profiles');
  }

  /** Host-mode executor config (the ambient `az login`). */
  private get cfg(): AzExecOptions {
    return { configDir: this.options.configDir, timeoutMs: 120_000, allowGroups: AZURE_PROVIDER_GROUPS };
  }

  /** Executor config bound to ONE org's isolated profile. */
  private cfgFor(account: AzureAccount, write = false): AzExecOptions {
    return {
      configDir: join(this.profilesRoot, profileKey(account)),
      timeoutMs: write ? ACTION_TIMEOUT_MS : 120_000,
      allowGroups: write ? new Set([...AZURE_PROVIDER_GROUPS, ...AZURE_WRITE_GROUPS]) : AZURE_PROVIDER_GROUPS,
      allowWrites: write,
    };
  }

  /** Executor config for host-mode mutating calls (tags, actions). */
  private get writeCfg(): AzExecOptions {
    return {
      ...this.cfg,
      timeoutMs: ACTION_TIMEOUT_MS,
      allowGroups: new Set([...AZURE_PROVIDER_GROUPS, ...AZURE_WRITE_GROUPS]),
      allowWrites: true,
    };
  }

  /** Delete on-disk profiles of orgs that are no longer configured. Best-effort. */
  private async pruneProfiles(live: Set<string>): Promise<void> {
    try {
      const entries = await readdir(this.profilesRoot, { withFileTypes: true });
      await Promise.all(
        entries
          .filter((e) => e.isDirectory() && e.name.startsWith('sp-') && !live.has(e.name))
          .map((e) => rm(join(this.profilesRoot, e.name), { recursive: true, force: true })),
      );
    } catch {
      // Root doesn't exist yet (nothing to prune) or is unreadable — never fatal.
    }
  }

  /**
   * `az login --service-principal` into `configDir` and return the subscriptions
   * THIS login surfaced (the login output, not `az account list`, so a profile
   * never reports another org's subscriptions).
   */
  private async loginInto(account: AzureAccount, configDir: string, ctx: ProviderContext): Promise<AzSubscription[]> {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const subs = await az<AzSubscription[]>(
      [
        'login',
        '--service-principal',
        '-u',
        account.clientId,
        '-p',
        account.clientSecret,
        '--tenant',
        account.tenantId,
        '--only-show-errors',
      ],
      { configDir, timeoutMs: 120_000, allowGroups: AZURE_PROVIDER_GROUPS },
    );
    ctx.log('info', `authenticated org "${account.name}"`, {
      tenantId: account.tenantId,
      subscriptions: subs?.length ?? 0,
    });
    return subs ?? [];
  }

  /**
   * Ensure an org's profile holds a valid session and return its subscriptions.
   * Concurrent callers share one in-flight login. `refresh` re-logs in when the
   * session is older than {@link SESSION_REFRESH_MS} (discovery uses it so newly
   * granted subscriptions appear); `force` always re-logs in (expired session).
   */
  private ensureAccountSession(
    account: AzureAccount,
    ctx: ProviderContext,
    mode: 'reuse' | 'refresh' | 'force' = 'reuse',
  ): Promise<AzSubscription[]> {
    const key = profileKey(account);
    const secretHash = sha(account.clientSecret);
    const existing = this.sessions.get(key);
    const usable =
      existing &&
      existing.secretHash === secretHash &&
      (mode === 'reuse' || (mode === 'refresh' && Date.now() - existing.createdAt < SESSION_REFRESH_MS));
    if (usable) return existing.ready;

    const ready = this.loginInto(account, this.cfgFor(account).configDir!, ctx);
    const session: OrgSession = { secretHash, createdAt: Date.now(), ready };
    this.sessions.set(key, session);
    // A failed login must not poison the cache — the next caller retries.
    ready.catch(() => {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    });
    return ready;
  }

  /**
   * Run `fn` against an org's profile. If Azure reports the session is gone
   * (expired/evicted cache), log in again once and retry.
   */
  private async withAccount<T>(
    account: AzureAccount,
    ctx: ProviderContext,
    fn: (cfg: AzExecOptions) => Promise<T>,
    write = false,
  ): Promise<T> {
    await this.ensureAccountSession(account, ctx);
    try {
      return await fn(this.cfgFor(account, write));
    } catch (err) {
      if (!(err instanceof AzError) || err.code !== 'NOT_LOGGED_IN') throw err;
      ctx.log('warn', `session for org "${account.name}" expired; re-authenticating`);
      await this.ensureAccountSession(account, ctx, 'force');
      return fn(this.cfgFor(account, write));
    }
  }

  /**
   * Build the subscription→account map without a full scope discovery. Used by
   * capability methods (cost, tags) that may run before any inventory sync has
   * primed the map in this process.
   */
  private async ensureSubAccountMap(ctx: ProviderContext): Promise<void> {
    if (this.accounts.length === 0 || this.subToAccount.size > 0) return;
    for (const account of this.accounts) {
      try {
        const subs = await this.ensureAccountSession(account, ctx);
        for (const s of subs) if (!this.subToAccount.has(s.id)) this.subToAccount.set(s.id, account);
      } catch (err) {
        ctx.log('warn', `skipped org "${account.name}" while mapping subscriptions`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** The org that owns a subscription (multi-org), or undefined in host mode. */
  private async accountForSubscription(subExternalId: string, ctx: ProviderContext): Promise<AzureAccount | undefined> {
    if (this.accounts.length === 0) return undefined;
    await this.ensureSubAccountMap(ctx);
    const account = this.subToAccount.get(subExternalId);
    if (!account) {
      throw new AzError(
        `Subscription ${subExternalId} is not visible to any configured organization.`,
        'FORBIDDEN',
      );
    }
    return account;
  }

  /** Run an Azure call scoped to a subscription, under the right org (or host) session. */
  private async forSubscription<T>(
    subExternalId: string,
    ctx: ProviderContext,
    fn: (cfg: AzExecOptions) => Promise<T>,
    write = false,
  ): Promise<T> {
    const account = await this.accountForSubscription(subExternalId, ctx);
    if (!account) return fn(write ? this.writeCfg : this.cfg);
    return this.withAccount(account, ctx, fn, write);
  }

  /** Run `fn` against a disposable Azure CLI profile, then delete it. */
  private async withThrowawayProfile<T>(fn: (configDir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'cloudops-az-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async testConnection(ctx: ProviderContext): Promise<ConnResult> {
    try {
      const first = this.accounts[0];
      const acc = first
        ? await this.withAccount(first, ctx, (cfg) =>
            az<AzSubscription & { user?: { name?: string } }>(['account', 'show'], cfg),
          )
        : await az<AzSubscription & { user?: { name?: string } }>(['account', 'show'], this.cfg);
      return {
        ok: true,
        message: `Connected to "${acc.name}"`,
        identity: { tenantId: acc.tenantId, subscriptionId: acc.id, name: acc.name },
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Test each configured org's service principal independently (read access),
   * without running a full sync. Host mode returns a single ambient-session
   * result. A failing org never affects the others — you get a per-org verdict.
   */
  async testConnections(ctx: ProviderContext): Promise<AccountConnResult[]> {
    if (this.accounts.length === 0) {
      const r = await this.testConnection(ctx);
      return [
        {
          account: 'host (az login)',
          ok: r.ok,
          message: r.message,
          tenantId: r.identity?.tenantId,
          subscriptions: r.ok ? 1 : 0,
        },
      ];
    }

    // Each check logs in to a throwaway profile, so the verdict reflects only the
    // credentials as they are right now and never disturbs a live session.
    const results: AccountConnResult[] = [];
    for (const account of this.accounts) {
      try {
        const subs = await this.withThrowawayProfile((dir) => this.loginInto(account, dir, ctx));
        results.push({
          account: account.name,
          ok: true,
          message: `Authenticated — ${subs.length} subscription(s) visible`,
          tenantId: account.tenantId,
          subscriptions: subs.length,
        });
      } catch (err) {
        results.push({
          account: account.name,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          tenantId: account.tenantId,
        });
      }
    }
    return results;
  }

  /**
   * Validate ONE service principal that has not been saved yet — what the
   * Providers page calls before storing a new or edited org. It runs the same
   * `az login --service-principal` a sync would, in a throwaway profile, so "it
   * passed here" means the SP really can read the tenant. Nothing is persisted.
   */
  async testAccountCredentials(account: AccountCredentials, ctx: ProviderContext): Promise<AccountConnResult> {
    const name = account.name?.trim() || 'New organization';
    const tenantId = account.tenantId?.trim();
    const clientId = account.clientId?.trim();
    const clientSecret = account.clientSecret;
    if (!tenantId || !clientId || !clientSecret) {
      return { account: name, ok: false, message: 'tenantId, clientId and clientSecret are required' };
    }

    try {
      const subs = await this.withThrowawayProfile((dir) =>
        this.loginInto({ name, tenantId, clientId, clientSecret }, dir, ctx),
      );
      return {
        account: name,
        ok: true,
        message: `Authenticated — ${subs.length} subscription(s) visible`,
        tenantId,
        subscriptions: subs.length,
      };
    } catch (err) {
      return {
        account: name,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        tenantId,
      };
    }
  }

  async *discoverScopes(ctx: ProviderContext): AsyncIterable<Scope> {
    this.seenSubs.clear();
    this.subToAccount.clear();
    const accounts = this.accounts;
    if (accounts.length > 0) {
      // Multi-org mode: a fresh login per org (picks up newly granted
      // subscriptions), each into its own isolated profile.
      for (const account of accounts) {
        let subs: AzSubscription[];
        try {
          subs = await this.ensureAccountSession(account, ctx, 'refresh');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.log('warn', `skipped org "${account.name}" (login failed)`, { error: message });
          ctx.reportIssue?.({ account: account.name, message: `Sign-in failed: ${message}` });
          continue;
        }
        yield* this.emitScopesForSubs(subs, ctx, account);
      }
      return;
    }

    // Host mode: single ambient session across all visible tenants.
    const subs = await az<AzSubscription[]>(['account', 'list', '--all'], this.cfg);
    yield* this.emitScopesForSubs(subs, ctx);
  }

  /** Yield subscription + resource-group scopes for a set of subscriptions. */
  private async *emitScopesForSubs(
    subs: AzSubscription[],
    ctx: ProviderContext,
    account?: AzureAccount,
  ): AsyncIterable<Scope> {
    const filtered = this.options.subscriptionFilter
      ? subs.filter((s) => s.id === this.options.subscriptionFilter)
      : subs;

    for (const sub of filtered) {
      if (account) {
        // Dedupe cross-tenant visibility: the first org to see a subscription
        // owns it. Prevents double-processing and org-name flip-flop.
        if (this.seenSubs.has(sub.id)) continue;
        this.seenSubs.add(sub.id);
        this.subToAccount.set(sub.id, account);
      }
      const scope = mapSubscription(sub);
      // Attribute to the ORG (the SP's tenant), not the subscription's home tenant.
      if (account) scope.metadata = { ...scope.metadata, tenantId: account.tenantId, orgName: account.name };
      yield scope;
      ctx.log('debug', `discovered subscription ${sub.name}`, { id: sub.id, org: account?.name });

      if (sub.state && sub.state !== 'Enabled') continue;

      // Resource groups — best-effort; a failing subscription never aborts the run.
      try {
        const listGroups = (cfg: AzExecOptions) =>
          az<AzResourceGroup[]>(['group', 'list', '--subscription', sub.id], cfg);
        const rgs = account ? await this.withAccount(account, ctx, listGroups) : await listGroups(this.cfg);
        for (const rg of rgs) yield mapResourceGroup(rg, sub.id);
      } catch (err) {
        ctx.log('warn', `skipped resource groups for subscription ${sub.name}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async *discoverResources(scope: Scope, ctx: ProviderContext): AsyncIterable<ResourceRecord> {
    if (scope.kind !== 'subscription') return;

    // Preferred path: Azure Resource Graph — one fast query returning tags, sku,
    // identity, managedBy and the full properties bag (real creation time, etc.).
    try {
      const rows = await this.forSubscription(scope.externalId, ctx, (cfg) => queryResources(scope.externalId, cfg));
      ctx.log('info', `discovered ${rows.length} resources in ${scope.name} (resource-graph)`);
      for (const r of rows) yield mapGraphResource(r, this.ownerTag);
      return;
    } catch (err) {
      // Fallback keeps sync working when the resource-graph extension is missing
      // or the query fails; loses only the enriched fields, never the inventory.
      ctx.log('warn', `resource-graph unavailable for ${scope.name}, falling back to 'resource list'`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const resources = await this.forSubscription(scope.externalId, ctx, (cfg) =>
      az<AzResource[]>(['resource', 'list', '--subscription', scope.externalId], cfg),
    );
    ctx.log('info', `discovered ${resources.length} resources in ${scope.name} (resource list)`);
    for (const r of resources) yield mapResource(r, this.ownerTag);
  }

  async getResourceDetail(externalId: string, ctx: ProviderContext): Promise<ResourceDetail> {
    const show = (cfg: AzExecOptions) => az<AzResource>(['resource', 'show', '--ids', externalId], cfg);
    const subId = subscriptionOf(externalId);
    const r = subId ? await this.forSubscription(subId, ctx, show) : await show(this.cfg);
    return { ...mapResource(r, this.ownerTag), raw: r };
  }

  /**
   * `cost` capability: daily per-resource actual cost for a subscription, queried
   * under the owning org's profile. A failed query throws a CostQueryError that
   * says why (throttled, network, no access, unsupported offer, other), so the
   * sync can retry the transient ones and report the rest instead of recording
   * the subscription as simply having no cost.
   */
  async getCost(
    subscriptionExternalId: string,
    query: CostQuery,
    ctx: ProviderContext,
  ): Promise<ProviderCostRecord[]> {
    try {
      const records = await this.forSubscription(subscriptionExternalId, ctx, (cfg) =>
        queryCost(subscriptionExternalId, query.from, query.to, {
          ...cfg,
          onThrottle: (attempt, delayMs) =>
            ctx.log('warn', `cost query throttled for ${subscriptionExternalId}; backing off`, {
              attempt,
              delayMs,
            }),
          onNetworkRetry: (attempt, delayMs) =>
            ctx.log('warn', `cost query couldn't reach Azure for ${subscriptionExternalId}; retrying`, {
              attempt,
              delayMs,
            }),
        }),
      );
      ctx.log('info', `cost: ${records.length} daily record(s) for ${subscriptionExternalId}`);
      return records;
    } catch (err) {
      const failure = toCostQueryError(err);
      ctx.log('warn', `cost query failed for ${subscriptionExternalId}`, {
        kind: failure.kind,
        reason: failure.message,
        // The raw az output can be a multi-page Python traceback; keep the head.
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 600),
      });
      throw failure;
    }
  }

  /** `actions`: the exact command `executeAction` runs — shown in the dry-run preview. */
  previewAction(action: ProviderAction): string {
    return ['az', ...actionArgs(action)].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  }

  /**
   * `actions` capability (WRITE): one change to one resource, under the owning
   * org's profile. Refused outright unless write-back is enabled. Waits for the
   * operation to finish, so the caller can verify it by reading the resource back.
   */
  async executeAction(action: ProviderAction, ctx: ProviderContext): Promise<{ message?: string }> {
    if (!this.options.writeEnabled) throw new AzError('Write-back to Azure is disabled (AZURE_ALLOW_WRITE=false).', 'FORBIDDEN');
    const args = actionArgs(action);
    const run = (cfg: AzExecOptions) => az<unknown>(args, cfg);
    const subId = subscriptionOf(action.externalId);
    if (subId) await this.forSubscription(subId, ctx, run, true);
    else await run(this.writeCfg);
    ctx.log('info', `action ${action.kind} applied`, { resource: action.externalId });
    return { message: `${args[0]} ${args[1]} completed` };
  }

  /** `activity` capability: the Azure activity log for one resource since `fromIso` (max 90 days back). */
  async getActivity(externalId: string, fromIso: string, ctx: ProviderContext): Promise<ActivityEntry[]> {
    type Row = {
      eventTimestamp?: string;
      operationName?: { localizedValue?: string; value?: string };
      caller?: string;
      status?: { localizedValue?: string; value?: string };
      correlationId?: string;
    };
    const args = ['monitor', 'activity-log', 'list', '--resource-id', externalId, '--start-time', fromIso, '--max-events', '100'];
    const run = (cfg: AzExecOptions) => az<Row[]>(args, cfg);
    const subId = subscriptionOf(externalId);
    const rows = (subId ? await this.forSubscription(subId, ctx, run) : await run(this.cfg)) ?? [];
    return rows
      .map((r) => ({
        at: r.eventTimestamp ?? '',
        operation: r.operationName?.localizedValue || r.operationName?.value || 'operation',
        caller: r.caller ?? null,
        status: r.status?.localizedValue || r.status?.value || null,
        correlationId: r.correlationId ?? null,
      }))
      .filter((r) => r.at)
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  /**
   * `tags` capability (WRITE): set tags on a resource or resource group by ARM id
   * via the `Microsoft.Resources/tags` API (`az tag update`), under the owning
   * org's profile. Returns the entity's tag set after the operation. Throws
   * AzError on failure (the caller classifies untaggable types vs. real errors).
   */
  async updateResourceTags(
    externalId: string,
    operation: 'Merge' | 'Delete' | 'Replace',
    tags: Record<string, string>,
    ctx: ProviderContext,
  ): Promise<Record<string, string>> {
    // Each pair is one argv entry after `--tags`; a name starting with `-` would
    // be parsed by az as an option (e.g. `--operation=Replace`), and `=` in a
    // name cannot be expressed. Refuse both rather than write the wrong thing.
    const unsafe = Object.keys(tags).find((k) => k.startsWith('-') || k.includes('='));
    if (unsafe !== undefined) {
      throw new AzError(`Tag name "${unsafe}" cannot be written through the Azure CLI`, 'CLI_ERROR');
    }
    const pairs = Object.entries(tags).map(([k, v]) => `${k}=${v}`);
    const args = ['tag', 'update', '--resource-id', externalId, '--operation', operation, '--tags', ...pairs, '--only-show-errors'];
    const run = (cfg: AzExecOptions) => az<{ properties?: { tags?: Record<string, string> } }>(args, cfg);
    const subId = subscriptionOf(externalId);
    const result = subId ? await this.forSubscription(subId, ctx, run, true) : await run(this.writeCfg);
    ctx.log('info', `tag ${operation.toLowerCase()} applied`, { resource: externalId, tags: pairs.length });
    return result?.properties?.tags ?? {};
  }
}
