import { az, AzError, summarizeAzError, type AzExecOptions } from './az-exec.js';
import { CostQueryError, type ProviderCostRecord } from '@cloudops/provider-sdk';

/**
 * Azure Cost Management — daily, per-resource actual cost for a subscription.
 *
 * Calls the Cost Management Query REST API via `az rest` (core CLI — no extension
 * needed; the `costmanagement` extension dropped its `query` command). `az rest`
 * reuses the active session's ARM token. The result is a columns/rows table which
 * we normalize by column name, so it tolerates ordering/field differences across
 * billing offers. The cost metric name varies by offer (`Cost` on modern/MCA,
 * `PreTaxCost` on EA/sponsorship), so we try both.
 */

const API_VERSION = '2023-11-01';

function queryUrl(subscriptionExternalId: string): string {
  return `https://management.azure.com/subscriptions/${subscriptionExternalId}/providers/Microsoft.CostManagement/query?api-version=${API_VERSION}`;
}

function queryBody(from: string, to: string, metric: string): string {
  return JSON.stringify({
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: { from, to },
    dataset: {
      granularity: 'Daily',
      aggregation: { totalCost: { name: metric, function: 'Sum' } },
      grouping: [{ type: 'Dimension', name: 'ResourceId' }],
    },
  });
}

interface CostQueryResult {
  columns?: { name: string; type: string }[];
  rows?: unknown[][];
  nextLink?: string | null;
  properties?: {
    columns?: { name: string; type: string }[];
    rows?: unknown[][];
    nextLink?: string | null;
  };
}

const METRICS = ['Cost', 'PreTaxCost'];

function findIndex(columns: { name: string }[], re: RegExp): number {
  return columns.findIndex((c) => re.test(c.name));
}

/** 20240115 (number or string) → '2024-01-15'. */
function parseUsageDate(raw: unknown): string | undefined {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

/**
 * Normalize a Cost Management `columns`/`rows` result to ProviderCostRecords,
 * mapping by column name so field ordering/naming differences are tolerated.
 * Exported for unit testing.
 */
export function normalizeCostResult(result: CostQueryResult): ProviderCostRecord[] {
  const columns = result.properties?.columns ?? result.columns ?? [];
  const rows = result.properties?.rows ?? result.rows ?? [];
  if (columns.length === 0 || rows.length === 0) return [];

  const costIdx = findIndex(columns, /^(cost|pretaxcost|costusd)$/i);
  const dateIdx = findIndex(columns, /date/i);
  const resIdx = findIndex(columns, /resourceid/i);
  const curIdx = findIndex(columns, /currency/i);
  if (costIdx < 0 || dateIdx < 0 || resIdx < 0) return [];

  const out: ProviderCostRecord[] = [];
  for (const row of rows) {
    const resourceExternalId = String(row[resIdx] ?? '').toLowerCase();
    const date = parseUsageDate(row[dateIdx]);
    const cost = Number(row[costIdx]);
    if (!resourceExternalId || !date || Number.isNaN(cost)) continue;
    out.push({
      resourceExternalId,
      date,
      cost,
      // Unknown currency stays unknown (''), so the cost sync refuses to store it
      // rather than guessing — a wrong guess would be off by the exchange rate.
      currency: curIdx >= 0 ? String(row[curIdx] ?? '').toUpperCase() : '',
    });
  }
  return out;
}

async function postQuery(url: string, body: string, options: AzExecOptions): Promise<CostQueryResult> {
  return az<CostQueryResult>(
    [
      'rest',
      '--method',
      'post',
      '--url',
      url,
      '--headers',
      'Content-Type=application/json',
      '--body',
      body,
      '--only-show-errors',
    ],
    options,
  );
}

/** Safety valve so a pathological nextLink chain can never loop forever. */
const MAX_PAGES = 50;

/**
 * Throttling policy. Cost Management rate-limits per scope per minute and its
 * 429s normally clear inside a minute, so we retry the SAME call on a widening
 * schedule instead of giving up on the subscription. `az rest` does not surface
 * the `Retry-After` / `x-ms-ratelimit-*` response headers, so the schedule is
 * fixed rather than server-driven.
 */
const RETRY_DELAYS_MS = [20_000, 60_000, 120_000];
/** Spacing between successive page calls, to stay under the limit by default. */
const PAGE_DELAY_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottled(err: unknown): boolean {
  return err instanceof AzError && err.code === 'THROTTLED';
}

/** Short waits before re-sending a request that never reached Azure. */
const NETWORK_RETRY_DELAYS_MS = [5_000, 15_000];

const CONNECTION_ERROR =
  /Network is unreachable|Failed to establish a new connection|Connection (?:aborted|reset|refused)|RemoteDisconnected|Temporary failure in name resolution|Name or service not known|getaddrinfo failed|Read timed out|ConnectTimeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;

/** The request never got an answer: DNS failure, no route, dropped connection. */
export function isConnectionError(err: unknown): boolean {
  return err instanceof AzError && err.code === 'CLI_ERROR' && CONNECTION_ERROR.test(err.message);
}

/** Transient: worth retrying later, and never a reason to try the next metric. */
function isTransient(err: unknown): boolean {
  return isThrottled(err) || isConnectionError(err) || (err instanceof AzError && err.code === 'TIMEOUT');
}

const NO_ACCESS =
  /AuthorizationFailed|RBACAccessDenied|does not have authori[sz]ation|\((?:Forbidden|Unauthorized)\)|InvalidAuthenticationToken|Azure rejected these credentials/i;
const UNSUPPORTED =
  /offer\b[^.\n]*not supported|(?:subscription|offer|agreement) type[^.\n]*not supported|SubscriptionTypeNotSupported|IndirectCostDisabled/i;

/**
 * Turn a failed cost query into a {@link CostQueryError}: what went wrong in
 * words an operator can act on, and whether it is worth retrying.
 */
export function toCostQueryError(err: unknown): CostQueryError {
  if (err instanceof CostQueryError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const detail = summarizeAzError(msg.replace(/^az failed:\s*/, '')).slice(0, 300);
  if (isThrottled(err)) return new CostQueryError('Azure is rate-limiting cost queries for this subscription.', 'throttled');
  if (err instanceof AzError && err.code === 'TIMEOUT') return new CostQueryError('The cost query timed out.', 'network');
  if (isConnectionError(err)) {
    const why = /\[Errno -?\d+\]\s*([^"'()\\\]\n]+)/.exec(msg)?.[1]?.trim();
    return new CostQueryError(`Couldn't reach Azure${why ? ` (${why})` : ''}.`, 'network');
  }
  if (/not visible to any configured organization/i.test(msg)) {
    return new CostQueryError(
      'None of the configured organizations can see this subscription: it may have been disabled or moved, or its organization removed.',
      'no-access',
    );
  }
  if (err instanceof AzError && err.code === 'NOT_LOGGED_IN') {
    return new CostQueryError("Couldn't sign in to this subscription's organization. Test its credentials on the Providers page.", 'no-access');
  }
  if (NO_ACCESS.test(msg)) {
    return new CostQueryError(
      `The organization's credentials can't read cost for this subscription. Give its service principal the Cost Management Reader role on the subscription. Azure said: ${detail}`,
      'no-access',
    );
  }
  if (UNSUPPORTED.test(msg)) return new CostQueryError(`Azure Cost Management doesn't support this subscription. Azure said: ${detail}`, 'unsupported');
  return new CostQueryError(detail || 'The cost query failed.', 'error');
}

/** Full jitter, so parallel callers do not retry in lockstep. */
function jittered(ms: number): number {
  return Math.round(ms / 2 + Math.random() * (ms / 2));
}

export interface CostQueryOptions extends AzExecOptions {
  /** Called before each backoff sleep — lets the caller log the wait. */
  onThrottle?: (attempt: number, delayMs: number) => void;
  /** Called before re-sending a request that failed to reach Azure. */
  onNetworkRetry?: (attempt: number, delayMs: number) => void;
}

/**
 * POST a page, retrying on 429 with backoff and on a network blip (a couple of
 * quick retries). Other errors propagate at once.
 */
async function postWithRetry(url: string, body: string, options: CostQueryOptions): Promise<CostQueryResult> {
  let throttles = 0;
  let blips = 0;
  for (;;) {
    try {
      return await postQuery(url, body, options);
    } catch (err) {
      if (isThrottled(err)) {
        const delay = RETRY_DELAYS_MS[throttles++];
        if (delay === undefined) throw err;
        const wait = jittered(delay);
        options.onThrottle?.(throttles, wait);
        await sleep(wait);
      } else if (isConnectionError(err)) {
        const delay = NETWORK_RETRY_DELAYS_MS[blips++];
        if (delay === undefined) throw err;
        options.onNetworkRetry?.(blips, delay);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Run the query and follow `nextLink` until the result set is exhausted.
 *
 * Cost Management caps a query response at 5000 rows and returns the remainder
 * behind `properties.nextLink` — which must be fetched with the SAME POST body.
 * Rows come back oldest-first, so ignoring the link silently truncates the most
 * RECENT days (a busy subscription simply stops reporting cost mid-window).
 */
async function runQuery(
  subscriptionExternalId: string,
  from: string,
  to: string,
  metric: string,
  options: CostQueryOptions,
): Promise<ProviderCostRecord[]> {
  const body = queryBody(from, to, metric);
  let url: string | null = queryUrl(subscriptionExternalId);
  const out: ProviderCostRecord[] = [];

  for (let page = 0; url && page < MAX_PAGES; page++) {
    if (page > 0) await sleep(PAGE_DELAY_MS);
    const result: CostQueryResult = await postWithRetry(url, body, options);
    out.push(...normalizeCostResult(result));
    const next = result.properties?.nextLink ?? result.nextLink ?? null;
    url = next && next !== url ? next : null;
  }
  return out;
}

/**
 * Query daily per-resource cost for a subscription. Tries each cost metric until
 * one succeeds; throws the last error if all fail.
 *
 * A 429 or network failure that survives its retries is rethrown immediately:
 * it means "come back later", not "wrong metric", so falling through to the
 * next metric would just repeat the failure (and double the load on a scope
 * Azure has already asked us to leave alone).
 */
export async function queryCost(
  subscriptionExternalId: string,
  from: string,
  to: string,
  options: CostQueryOptions = {},
): Promise<ProviderCostRecord[]> {
  let lastErr: unknown;
  for (const metric of METRICS) {
    try {
      return await runQuery(subscriptionExternalId, from, to, metric, options);
    } catch (err) {
      if (isTransient(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('cost query failed');
}
