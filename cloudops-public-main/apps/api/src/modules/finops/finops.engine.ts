import type { EventBus, Logger } from '@cloudops/kernel';
import type { CredentialChain } from '@cloudops/credentials';
import type { ProviderRegistry } from '@cloudops/provider-sdk';
import type { CostFailureKind, ProviderCostRecord } from '@cloudops/provider-sdk';
import type { CostSyncOutcome, CostSyncSubscriptionResultDto } from '@cloudops/core';
import type { CostRow, FinopsRepository } from './finops.repository.js';
import type { FxRates } from './fx.js';

export interface FinopsEngineDeps {
  registry: ProviderRegistry;
  credentials: CredentialChain;
  repo: FinopsRepository;
  events: EventBus;
  logger: Logger;
  windowDays: number;
  /** Converts non-reporting-currency cost at ingest. */
  fx: FxRates;
}

export interface FinopsJob {
  providerKey: string;
  days?: number;
  /**
   * Restrict the run to these subscription external ids. Used by the automatic
   * retry job so a throttled subscription is re-pulled on its own, instead of
   * replaying the whole estate against a rate limit.
   */
  subscriptionExternalIds?: string[];
}

export interface FinopsRunResult {
  records: number;
  subscriptions: number;
  /** Subscriptions not updated, for any reason. */
  skipped: number;
  /** Subscriptions Azure throttled — worth retrying shortly. */
  throttled: string[];
  /** Subscriptions whose query failed transiently (throttled or network) — retried automatically. */
  retry: string[];
  /** Subscriptions left untouched because their billing currency couldn't be converted. */
  unconverted?: string[];
  /** What happened to each subscription, and why. */
  results: CostSyncSubscriptionResultDto[];
}

/** Rollups (Resource.costMonthly/costDaily) always describe the trailing month. */
export const ROLLUP_DAYS = 30;

/** Spacing between subscriptions, so one run does not burst at Azure. */
const SUBSCRIPTION_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FAILURE_KINDS: readonly CostFailureKind[] = ['throttled', 'network', 'no-access', 'unsupported', 'error'];

/**
 * Why a provider's cost query failed. Structural, so the engine stays
 * provider-agnostic: a CostQueryError carries `kind`; a bare error with code
 * THROTTLED (older providers) still counts as throttling.
 */
function failureOf(err: unknown): { kind: CostFailureKind; message: string } {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { kind?: string; code?: string; message?: string };
  const kind = FAILURE_KINDS.find((k) => k === e.kind) ?? (e.code === 'THROTTLED' ? 'throttled' : 'error');
  const message = (typeof e.message === 'string' && e.message ? e.message : String(err)).slice(0, 400);
  return { kind, message };
}

/** Azure subscription states that can't be queried (Warned and PastDue still can). */
const INACTIVE_STATES = new Set(['disabled', 'deleted']);

/** Derive the canonical (lowercased) RG external id from a resource id. */
/** Amount in the reporting currency, plus the original when it was converted. */
function convert(
  r: ProviderCostRecord,
  rates: Map<string, number>,
  reporting: string,
): Pick<CostRow, 'cost' | 'currency' | 'originalCost' | 'originalCurrency' | 'fxRate'> {
  const code = r.currency.toUpperCase();
  if (code === reporting) return { cost: r.cost, currency: reporting };
  const rate = rates.get(code)!;
  return { cost: r.cost * rate, currency: reporting, originalCost: r.cost, originalCurrency: code, fxRate: rate };
}

function rgExternalIdFromResourceId(resourceExternalId: string): string | null {
  const m = /\/subscriptions\/([^/]+)\/resourcegroups\/([^/]+)/i.exec(resourceExternalId);
  return m ? `/subscriptions/${m[1]}/resourcegroups/${m[2]}`.toLowerCase() : null;
}

/**
 * Cost sync engine. For each subscription it pulls daily per-resource cost via
 * the provider's `cost` capability, replaces the window idempotently in
 * CostRecord, then recomputes resource-level rollups (costDaily/costMonthly).
 *
 * Best-effort and resilient: a subscription that can't be updated (disabled,
 * query failed, no exchange rate) keeps its existing cost data and never aborts
 * the run. Each subscription's outcome is recorded with the reason, and
 * transient failures (throttling, network) are handed to the retry job.
 */
export class FinopsEngine {
  constructor(private readonly deps: FinopsEngineDeps) {}

  async run(job: FinopsJob): Promise<FinopsRunResult> {
    const { registry, credentials, repo, events, logger } = this.deps;
    const log = logger.child({ provider: job.providerKey, job: 'cost-sync' });
    const days = job.days ?? this.deps.windowDays;

    const provider = registry.get(job.providerKey);
    if (!provider.getCost) {
      log.warn('provider has no cost capability; nothing to sync');
      return { records: 0, subscriptions: 0, skipped: 0, throttled: [], retry: [], results: [] };
    }

    const credential = await credentials.resolve({ providerKey: job.providerKey });
    const ctx = {
      credential,
      log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) =>
        log[level](msg, meta),
    };

    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const fromISO = from.toISOString();
    const toISO = to.toISOString();

    const [allSubs, resourceIndex] = await Promise.all([repo.listSubscriptions(), repo.resourceIndex()]);
    const only = job.subscriptionExternalIds;
    const subs = only?.length ? allSubs.filter((s) => only.includes(s.externalId)) : allSubs;
    // Azure ids are case-insensitive; where legacy duplicate rows exist, the active one gets the cost.
    const lowerMap = new Map<string, (typeof resourceIndex)[number]>();
    for (const r of resourceIndex) {
      const key = r.externalId.toLowerCase();
      const cur = lowerMap.get(key);
      if (!cur || (cur.state !== 'active' && r.state === 'active')) lowerMap.set(key, r);
    }

    let records = 0;
    const results: CostSyncSubscriptionResultDto[] = [];
    const record = (sub: (typeof subs)[number], outcome: CostSyncOutcome, message: string | null, count = 0) =>
      results.push({
        subscriptionId: sub.externalId,
        name: sub.name,
        organization: sub.tenant?.name ?? null,
        outcome,
        records: count,
        message,
      });
    let queried = 0;
    for (const sub of subs) {
      if (sub.state && INACTIVE_STATES.has(sub.state.toLowerCase())) {
        record(sub, 'disabled', `${sub.state} in Azure: not queried, existing cost data kept.`);
        continue;
      }
      if (queried++ > 0) await sleep(SUBSCRIPTION_DELAY_MS);
      let costRecords;
      try {
        costRecords = await provider.getCost(sub.externalId, { from: fromISO, to: toISO }, ctx);
      } catch (err) {
        // The subscription still has its data upstream — leave the existing
        // window untouched; transient failures go to the retry job.
        const failure = failureOf(err);
        record(sub, failure.kind, failure.message);
        log.warn('cost query failed for subscription', { subscription: sub.name, kind: failure.kind, reason: failure.message });
        continue;
      }
      if (costRecords.length === 0) {
        record(sub, 'no-data', 'Azure returned no cost for this window; existing cost data kept.');
        continue;
      }

      // One currency in the store, always: convert what Azure billed elsewhere.
      // If a rate is unknown, keep the subscription's existing window instead
      // of storing amounts that would be summed as the wrong currency.
      const rates = await this.ratesFor(costRecords);
      if (!rates) {
        const currencies = [...new Set(costRecords.map((r) => r.currency || '(none)'))];
        record(
          sub,
          'unconverted',
          `Billed in ${currencies.join(', ')} and no exchange rate to ${this.deps.fx.reporting} is available. Set COST_FX_RATES to pin one.`,
        );
        log.warn('cost not stored: no exchange rate for the billing currency', {
          subscription: sub.name,
          currencies,
          reporting: this.deps.fx.reporting,
        });
        continue;
      }

      const rows: CostRow[] = costRecords.map((r) => ({
        providerKey: job.providerKey,
        resourceExternalId: r.resourceExternalId,
        subscriptionExternalId: sub.externalId,
        resourceGroupExternalId: rgExternalIdFromResourceId(r.resourceExternalId),
        resourceId: lowerMap.get(r.resourceExternalId)?.id ?? null,
        date: new Date(`${r.date}T00:00:00.000Z`),
        ...convert(r, rates, this.deps.fx.reporting),
      }));
      await repo.replaceCostWindow(sub.externalId, from, to, rows);
      records += rows.length;
      record(sub, 'updated', null, rows.length);
    }

    // Recompute resource-level rollups (trailing 30 days — a true monthly
    // figure, independent of how wide a window this sync pulled).
    const rolled = await repo.recomputeRollups(ROLLUP_DAYS);
    log.debug('cost rollups recomputed', { resources: rolled });

    const ids = (...outcomes: CostSyncOutcome[]) =>
      results.filter((r) => outcomes.includes(r.outcome)).map((r) => r.subscriptionId);
    const throttled = ids('throttled');
    const retry = ids('throttled', 'network');
    await events.emit('finops.synced', { providerKey: job.providerKey, records, results, retrying: retry });
    const unconverted = results.filter((r) => r.outcome === 'unconverted').map((r) => r.name);
    const skipped = results.filter((r) => r.outcome !== 'updated').length;
    log.info('cost sync completed', {
      records,
      subscriptions: subs.length,
      skipped,
      outcomes: Object.fromEntries(
        [...new Set(results.map((r) => r.outcome))].map((o) => [o, results.filter((r) => r.outcome === o).length]),
      ),
    });
    return {
      records,
      subscriptions: subs.length,
      skipped,
      throttled,
      retry,
      results,
      ...(unconverted.length ? { unconverted } : {}),
    };
  }

  /** Rate per billing currency in this batch; null if any can't be converted. */
  private async ratesFor(records: ProviderCostRecord[]): Promise<Map<string, number> | null> {
    const rates = new Map<string, number>();
    for (const code of new Set(records.map((r) => r.currency.toUpperCase()))) {
      if (code === this.deps.fx.reporting) continue;
      if (!code) return null; // Azure didn't say which currency — never guess
      const fx = await this.deps.fx.rate(code);
      if (!fx) return null;
      rates.set(code, fx.rate);
    }
    return rates;
  }

  /**
   * Convert stored rows that are still in another currency (written before
   * conversion existed, or when no rate was known). SQL only — no Azure call.
   * Returns the number of rows converted.
   */
  async normalizeStoredCurrency(): Promise<number> {
    const { repo, fx, logger } = this.deps;
    let converted = 0;
    for (const code of await repo.foreignCurrencies(fx.reporting)) {
      const rate = await fx.rate(code);
      if (!rate) {
        logger.warn('stored cost left unconverted: no exchange rate', { currency: code, reporting: fx.reporting });
        continue;
      }
      const n = await repo.convertStoredCurrency(code, fx.reporting, rate.rate);
      converted += n;
      logger.info('converted stored cost to the reporting currency', { from: code, to: fx.reporting, rate: rate.rate, source: rate.source, rows: n });
    }
    return converted;
  }
}
