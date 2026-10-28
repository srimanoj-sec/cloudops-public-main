import type { Prisma as PrismaNS } from '@prisma/client';
import type { Job } from 'bullmq';
import {
  categoryForType,
  formatMoney,
  type BudgetInput,
  type BudgetScope,
  type BudgetStatusDto,
  type FinopsOverviewDto,
  type FinopsScopeQuery,
  type UnattributedItemDto,
  type UnattributedReason,
  type CostAnomaliesDto,
  type CostAnomaliesQuery,
  type CostAnomalyBand,
  type CostAnomalyDto,
  type CostCoverageDto,
  type CostSyncRunDto,
  type CostSyncStatus,
  type CostSyncSubscriptionResultDto,
  HEALTHY_COST_SYNC_OUTCOMES,
  type FinopsBreakdownRow,
  type FinopsGranularity,
  type FinopsGroupBy,
  type FinopsQuery,
  type FinopsQueryResult,
  type FinopsRange,
  type FinopsSeriesPoint,
  type ResourceCostTrendDto,
} from '@cloudops/core';
import { AppError } from '../../http/errors.js';
import { assertQueueAvailable, withQueueTimeout } from '../../infra/bullmq.js';
import { finopsQueue, type FinopsJobData } from '../../infra/queue.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import type { FinopsRepository } from './finops.repository.js';
import { DAY_MS, defaultMinDailyDelta, detectAnomalies, explain } from './anomaly.js';

/** Days of history a resource's expected range is computed from. */
const BASELINE_DAYS = 7;
/** Most anomalies returned (the rest are counted). */
const MAX_ANOMALIES = 50;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
function basename(externalId: string): string {
  const parts = externalId.split('/');
  return parts[parts.length - 1] || externalId;
}
/** Start of the given date in UTC. */
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function chunkDaysFor(g: FinopsGranularity): number {
  return g === 'month' ? 30 : g === 'week' ? 7 : 1;
}
function deltaPct(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return round(((current - previous) / previous) * 100);
}

type IndexedResource = { id: string; name: string; type: string; state?: string; owner?: string | null; tags?: unknown; platformTags?: unknown };

interface Indexes {
  subs: { id: string; externalId: string; name: string; tenant: { id: string; name: string } | null }[];
  subByExt: Map<string, { id: string; name: string; tenantId: string | null; tenantName: string | null }>;
  resourceByExt: Map<string, IndexedResource>;
  rgByExt: Map<string, { id: string; name: string }>;
}

/** Lower-cased id → resource, preferring the active row where legacy duplicates exist. */
function indexResources(rows: ({ externalId: string } & IndexedResource)[]): Map<string, IndexedResource> {
  const m = new Map<string, IndexedResource>();
  for (const r of rows) {
    const key = r.externalId.toLowerCase();
    const cur = m.get(key);
    if (!cur || (cur.state !== 'active' && r.state === 'active')) m.set(key, r);
  }
  return m;
}

/** `…/providers/microsoft.sql/servers/a/databases/b` → `microsoft.sql/servers/databases`. */
export function typeFromId(id: string): string | null {
  const m = /\/providers\/([^/]+)\/(.+)$/i.exec(id);
  if (!m) return null;
  const segs = m[2]!.split('/');
  return [m[1]!, ...segs.filter((_, i) => i % 2 === 0)].join('/').toLowerCase();
}

function tagOf(r: IndexedResource | undefined, key: string): string | null {
  if (!r) return null;
  const tags = { ...((r.tags as Record<string, string>) ?? {}), ...((r.platformTags as Record<string, string> | null) ?? {}) };
  const k = Object.keys(tags).find((t) => t.toLowerCase() === key.toLowerCase());
  return k ? (tags[k] ?? null) : null;
}

export class FinopsService {
  constructor(
    private readonly repo: FinopsRepository,
    private readonly windowDays: number,
    private readonly audit?: AuditService,
  ) {}

  /**
   * Queue a cost sync. Idempotent: while a cost sync is already waiting or
   * running, a second request returns that one (`deduplicated: true`) instead
   * of stacking another full pull against Azure's rate limits.
   */
  async enqueue(
    input: { providerKey: string; days?: number },
    actor?: AuditActor | null,
  ): Promise<{ status: string; days: number; deduplicated?: boolean }> {
    const days = input.days ?? this.windowDays;
    await assertQueueAvailable();
    const pending = await withQueueTimeout(finopsQueue.getJobs(['active', 'waiting']));
    const running = pending.find((j) => j?.name === 'cost-sync' && j.data.providerKey === input.providerKey);
    if (running) {
      const state = await running.getState();
      return { status: state === 'active' ? 'running' : 'queued', days: running.data.days ?? days, deduplicated: true };
    }
    const data: FinopsJobData = { providerKey: input.providerKey, days };
    await withQueueTimeout(finopsQueue.add('cost-sync', data, { removeOnComplete: 50, removeOnFail: 50, attempts: 1 }));
    await this.audit?.record({
      action: 'finops.sync.enqueue',
      entity: 'costSync',
      actor,
      metadata: { providerKey: input.providerKey, days },
    });
    return { status: 'queued', days };
  }

  /**
   * Recent cost-sync jobs, projected from the BullMQ queue (no DB row needed).
   * Lets the FinOps page show queued → running → completed like the inventory
   * sync feed. Delayed jobs are included only when they are throttle retries —
   * the repeatable-scheduler placeholder also sits in 'delayed' and is noise.
   */
  async recentSyncs(limit = 8): Promise<CostSyncRunDto[]> {
    await assertQueueAvailable();
    const jobs = await withQueueTimeout(finopsQueue.getJobs(['active', 'waiting', 'completed', 'failed', 'delayed']));
    return jobs
      .filter((j): j is Job<FinopsJobData> => Boolean(j))
      .filter((j) => j.name !== 'cost-sync' || j.processedOn !== undefined || (j.delay ?? 0) === 0)
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, limit)
      .map((j) => toCostSyncDto(j));
  }

  /**
   * Cost data coverage per subscription: the latest day with stored cost, and
   * the subscription's result in the most recent sync that included it (from
   * the retained job history). Subscriptions needing attention come first. If
   * the queue is unreachable, the stored dates are still returned.
   */
  async coverage(): Promise<CostCoverageDto[]> {
    const [subs, lastDates] = await Promise.all([this.repo.listSubscriptions(), this.repo.lastCostDates()]);
    const latest = new Map<string, NonNullable<CostCoverageDto['last']>>();
    try {
      await assertQueueAvailable();
      const jobs = await withQueueTimeout(finopsQueue.getJobs(['completed']));
      const byNewest = jobs
        .filter((j): j is Job<FinopsJobData> => Boolean(j))
        .sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0));
      for (const j of byNewest) {
        for (const r of resultsOf(j) ?? []) {
          if (!latest.has(r.subscriptionId)) {
            latest.set(r.subscriptionId, { ...r, at: j.finishedOn ? new Date(j.finishedOn).toISOString() : null });
          }
        }
      }
    } catch {
      // No job history available: coverage still shows what is stored.
    }

    const needsAttention = (c: CostCoverageDto) =>
      (c.last != null && !HEALTHY_COST_SYNC_OUTCOMES.includes(c.last.outcome)) ||
      (c.lastCostDate == null && c.last?.outcome !== 'disabled');
    return subs
      .map((s): CostCoverageDto => ({
        id: s.id,
        subscriptionId: s.externalId,
        name: s.name,
        organizationId: s.tenant?.id ?? null,
        organization: s.tenant?.name ?? null,
        state: s.state ?? null,
        lastCostDate: lastDates.get(s.externalId)?.toISOString().slice(0, 10) ?? null,
        last: latest.get(s.externalId) ?? null,
      }))
      .sort(
        (a, b) =>
          Number(needsAttention(b)) - Number(needsAttention(a)) ||
          (a.organization ?? '').localeCompare(b.organization ?? '') ||
          a.name.localeCompare(b.name),
      );
  }

  // ── Cost anomaly detection ───────────────────────────────────────
  /**
   * Resources (and regions) whose latest daily cost is outside what their recent
   * history predicts — spikes above the expected range, and spend that just
   * appeared. Every item says why it was flagged and what it costs per month if
   * it persists. See anomaly.ts for the rules.
   */
  async costAnomalies(q: CostAnomaliesQuery): Promise<CostAnomaliesDto> {
    const threshold = q.threshold ?? 10;
    const [subs, currencyRow, latest] = await Promise.all([
      this.repo.listSubscriptions(),
      this.repo.reportingCurrency(),
      this.repo.latestDate(),
    ]);
    const currency = currencyRow.currency;
    const empty: CostAnomaliesDto = {
      currency,
      threshold,
      minDailyDelta: q.minDelta ?? 0,
      baselineDays: BASELINE_DAYS,
      latestDate: null,
      bands: [],
      byKind: [],
      flagged: 0,
      totalMonthlyImpact: 0,
      anomalies: [],
    };
    if (!latest) return empty;

    const scopeExt = q.tenantId ? subs.filter((s) => s.tenant?.id === q.tenantId).map((s) => s.externalId) : null;
    if (scopeExt && scopeExt.length === 0) return { ...empty, latestDate: isoDay(latest) };

    // Window: the latest day plus the preceding baseline window.
    const windowStart = new Date(latest.getTime() - BASELINE_DAYS * DAY_MS);
    const where: PrismaNS.CostRecordWhereInput = {
      date: { gte: windowStart, lte: latest },
      ...(scopeExt ? { subscriptionExternalId: { in: scopeExt } } : {}),
    };
    const [rows, dayTotal, byLocation] = await Promise.all([
      this.repo.dailyCostByResource(where),
      this.repo.dayTotal(latest, scopeExt),
      this.repo.costByLocation(windowStart, latest, scopeExt),
    ]);
    const minDailyDelta = q.minDelta ?? defaultMinDailyDelta(dayTotal);

    const series = new Map<string, { date: number; cost: number }[]>();
    for (const r of rows) {
      const arr = series.get(r.resourceExternalId) ?? [];
      arr.push({ date: r.date.getTime(), cost: r._sum.cost ?? 0 });
      series.set(r.resourceExternalId, arr);
    }
    const detected = detectAnomalies(series, { latest: latest.getTime(), baselineDays: BASELINE_DAYS, threshold, minDailyDelta });

    const day = isoDay(latest);
    const fmt = (n: number) => formatMoney(n, currency, { compact: true });
    const context = new Map((await this.repo.resourcesForCostKeys(detected.slice(0, MAX_ANOMALIES).map((d) => d.key), latest)).map((r) => [r.key, r]));

    const anomalies: CostAnomalyDto[] = detected.map((a) => {
      const res = context.get(a.key);
      return {
        kind: a.kind,
        resourceId: res?.id ?? null,
        externalId: a.key,
        name: res?.name ?? basename(a.key),
        type: res?.type ?? typeFromId(a.key) ?? '',
        resourceGroup: res?.resourceGroup?.name ?? /\/resourcegroups\/([^/]+)/i.exec(a.key)?.[1] ?? null,
        subscription: res?.subscription?.name ?? null,
        location: res?.location ?? null,
        latest: a.latest,
        baseline: a.mean,
        expectedLow: a.expectedLow,
        expectedHigh: a.expectedHigh,
        deltaAbs: a.deltaAbs,
        deltaPct: a.deltaPct,
        monthlyImpact: a.monthlyImpact,
        band: a.kind === 'spike' && a.deltaPct !== null ? Math.min(100, Math.floor(a.deltaPct / 10) * 10) : 0,
        latestDate: day,
        reason: explain(a, fmt, day),
      };
    });

    // A region with no spend in the baseline that now has some.
    for (const loc of byLocation) {
      if (loc.prior > 0 || loc.latest < minDailyDelta) continue;
      anomalies.push({
        kind: 'new-region',
        resourceId: null,
        externalId: `region:${loc.location}`,
        name: loc.location,
        type: 'region',
        resourceGroup: null,
        subscription: null,
        location: loc.location,
        latest: round(loc.latest),
        baseline: 0,
        expectedLow: 0,
        expectedHigh: 0,
        deltaAbs: round(loc.latest),
        deltaPct: null,
        monthlyImpact: round(loc.latest * 30),
        band: 0,
        latestDate: day,
        reason: `First spend in ${loc.location} in ${BASELINE_DAYS} days: ${fmt(loc.latest)} on ${day} — about ${fmt(loc.latest * 30)}/month if it continues. Check nothing was deployed to an unexpected region.`,
      });
    }
    anomalies.sort((a, b) => b.monthlyImpact - a.monthlyImpact);

    const bandCounts = new Map<number, number>();
    for (const a of anomalies) if (a.kind === 'spike') bandCounts.set(a.band, (bandCounts.get(a.band) ?? 0) + 1);
    const bands: CostAnomalyBand[] = [...bandCounts.entries()]
      .map(([band, count]) => ({ band, count }))
      .sort((a, b) => a.band - b.band);
    const byKind = (['spike', 'new-resource', 'new-region'] as const)
      .map((kind) => ({ kind, count: anomalies.filter((a) => a.kind === kind).length }))
      .filter((k) => k.count > 0);

    return {
      currency,
      threshold,
      minDailyDelta,
      baselineDays: BASELINE_DAYS,
      latestDate: day,
      bands,
      byKind,
      flagged: anomalies.length,
      totalMonthlyImpact: round(anomalies.reduce((n, a) => n + a.monthlyImpact, 0)),
      anomalies: anomalies.slice(0, MAX_ANOMALIES),
    };
  }

  /** Budgets that are over or forecast to cross their alert threshold this month (estate-wide). */
  /** The reporting currency every stored amount is in. */
  async reportingCurrency(): Promise<string> {
    return (await this.repo.reportingCurrency()).currency;
  }

  async budgetAlerts(): Promise<BudgetStatusDto[]> {
    const [latest, subs] = await Promise.all([this.repo.latestDate(), this.repo.listSubscriptions()]);
    return (await this.budgetStatuses(latest, subs)).filter((b) => b.status !== 'ok');
  }

  // ── Cost explorer ────────────────────────────────────────────
  async query(q: FinopsQuery): Promise<FinopsQueryResult> {
    const range = resolveRange(q);
    const granularity: FinopsGranularity = q.granularity ?? defaultGranularity(range.days);

    const [subs, resources, rgs, currencyRow, earliest] = await Promise.all([
      this.repo.listSubscriptions(),
      this.repo.resourceIndex(),
      this.repo.resourceGroupIndex(),
      this.repo.reportingCurrency(),
      this.repo.earliestDate(),
    ]);
    const idx: Indexes = {
      subs,
      subByExt: new Map(
        subs.map((s) => [
          s.externalId,
          { id: s.id, name: s.name, tenantId: s.tenant?.id ?? null, tenantName: s.tenant?.name ?? null },
        ]),
      ),
      resourceByExt: indexResources(resources),
      rgByExt: new Map(rgs.map((r) => [r.externalId.toLowerCase(), { id: r.id, name: r.name }])),
    };

    const where = this.buildWhere(q, range.fromDate, range.toDate, idx);
    const current = await this.aggregate(where, q.groupBy, idx, range, granularity, q.tagKey);

    let previousTotal: number | null = null;
    let previousRange: FinopsRange | null = null;
    let previousComplete = false;
    let prevFrom: Date | null = null;
    let prevSeries: number[] = [];
    const prevByKey = new Map<string, number>();
    const chunk = chunkDaysFor(granularity);

    if (q.compare) {
      let prevTo: Date;
      if (q.compareFrom && q.compareTo) {
        // Custom baseline: use the chosen window as-is (inclusive 'to' → exclusive).
        prevFrom = utcMidnight(new Date(q.compareFrom));
        prevTo = new Date(utcMidnight(new Date(q.compareTo)).getTime() + DAY_MS);
      } else {
        // Auto: the immediately-preceding equal-length window.
        prevTo = range.fromDate;
        prevFrom = new Date(prevTo.getTime() - range.days * DAY_MS);
      }
      const prevDays = Math.max(1, Math.round((prevTo.getTime() - prevFrom.getTime()) / DAY_MS));
      previousRange = { from: prevFrom.toISOString(), to: prevTo.toISOString(), days: prevDays };
      // The comparison is only meaningful if we hold data covering the whole
      // previous window; otherwise it reads as a huge bogus jump.
      previousComplete = Boolean(earliest && prevFrom >= earliest);
      const prevWhere = this.buildWhere(q, prevFrom, prevTo, idx);
      // Series aligns by bucket index (current-length) from the previous start.
      const prev = await this.aggregate(prevWhere, q.groupBy, idx, { ...range, fromDate: prevFrom, toDate: prevTo }, granularity, q.tagKey);
      previousTotal = prev.total;
      prevSeries = prev.series.map((p) => p.cost);
      for (const b of prev.breakdown) prevByKey.set(b.key, b.cost);
    }

    // Merge previous into current series (aligned by bucket index) + breakdown (by key).
    const series: FinopsSeriesPoint[] = current.series.map((p, i) => ({
      bucket: p.bucket,
      cost: p.cost,
      ...(q.compare && prevFrom
        ? {
            previousCost: round(prevSeries[i] ?? 0),
            previousBucket: isoDay(new Date(prevFrom.getTime() + i * chunk * DAY_MS)),
          }
        : {}),
    }));
    const breakdown: FinopsBreakdownRow[] = current.breakdown.map((b) => {
      if (!q.compare) return b;
      const previousCost = round(prevByKey.get(b.key) ?? 0);
      return { ...b, previousCost, deltaPct: deltaPct(b.cost, previousCost) };
    });

    const total = current.total;
    return {
      currency: currencyRow.currency,
      groupBy: q.groupBy,
      granularity,
      range: { from: range.fromDate.toISOString(), to: range.toDate.toISOString(), days: range.days },
      previousRange,
      previousComplete,
      earliestData: earliest ? earliest.toISOString() : null,
      total,
      previousTotal,
      deltaAbs: previousTotal == null ? null : round(total - previousTotal),
      deltaPct: previousTotal == null ? null : deltaPct(total, previousTotal),
      hasData: total > 0 || series.some((s) => s.cost > 0),
      series,
      breakdown,
    };
  }

  private buildWhere(q: FinopsQuery, from: Date, to: Date, idx: Indexes): PrismaNS.CostRecordWhereInput {
    const where: PrismaNS.CostRecordWhereInput = { date: { gte: from, lt: to } };

    // Organization → the external ids of its subscriptions.
    if (q.tenantId) {
      const ext = idx.subs.filter((s) => s.tenant?.id === q.tenantId).map((s) => s.externalId);
      where.subscriptionExternalId = { in: ext.length ? ext : ['__none__'] };
    }
    if (q.subscriptionId) {
      const ext = idx.subs.find((s) => s.id === q.subscriptionId)?.externalId;
      where.subscriptionExternalId = ext ?? '__none__';
    }
    if (q.resourceGroupId) {
      const rg = [...idx.rgByExt.entries()].find(([, v]) => v.id === q.resourceGroupId);
      where.resourceGroupExternalId = rg ? rg[0] : '__none__';
    }
    if (q.resourceId) {
      const match = [...idx.resourceByExt.entries()].find(([, v]) => v.id === q.resourceId);
      where.resourceExternalId = match ? match[0] : '__none__';
    }
    return where;
  }

  private async aggregate(
    where: PrismaNS.CostRecordWhereInput,
    groupBy: FinopsGroupBy,
    idx: Indexes,
    range: { fromDate: Date; toDate: Date; days: number },
    granularity: FinopsGranularity,
    tagKey?: string,
  ): Promise<{ total: number; series: FinopsSeriesPoint[]; breakdown: FinopsBreakdownRow[] }> {
    const [sumAgg, byDate] = await Promise.all([this.repo.sumCost(where), this.repo.groupByDate(where)]);
    const total = round(sumAgg._sum.cost ?? 0);

    // Time series bucketed by granularity, aligned from range start.
    const chunk = chunkDaysFor(granularity);
    const buckets = Math.max(1, Math.ceil(range.days / chunk));
    const sums = new Array<number>(buckets).fill(0);
    const dayCost = new Map<string, number>(byDate.map((r) => [isoDay(r.date), r._sum.cost ?? 0]));
    for (let d = 0; d < range.days; d++) {
      const day = new Date(range.fromDate.getTime() + d * DAY_MS);
      const cost = dayCost.get(isoDay(day)) ?? 0;
      const b = Math.floor(d / chunk);
      sums[b] = (sums[b] ?? 0) + cost;
    }
    const series: FinopsSeriesPoint[] = sums.map((cost, i) => ({
      bucket: isoDay(new Date(range.fromDate.getTime() + i * chunk * DAY_MS)),
      cost: round(cost),
    }));

    const breakdown = await this.buildBreakdown(where, groupBy, idx, tagKey);
    return { total, series, breakdown };
  }

  private async buildBreakdown(
    where: PrismaNS.CostRecordWhereInput,
    groupBy: FinopsGroupBy,
    idx: Indexes,
    tagKey?: string,
  ): Promise<FinopsBreakdownRow[]> {
    // Groupings derived per billed resource: service type, category, owner, tag.
    if (groupBy === 'service' || groupBy === 'category' || groupBy === 'owner' || groupBy === 'tag') {
      const rows = await this.repo.groupByResource(where);
      const totals = new Map<string, { label: string; cost: number }>();
      for (const r of rows) {
        const res = idx.resourceByExt.get(r.resourceExternalId);
        const type = res?.type.toLowerCase() ?? typeFromId(r.resourceExternalId);
        let key: string;
        let label: string;
        if (groupBy === 'service') {
          key = type ?? 'other';
          label = type ? type.replace(/^microsoft\./, '') : 'Other';
        } else if (groupBy === 'category') {
          key = label = categoryForType(type);
        } else if (groupBy === 'owner') {
          key = res?.owner ?? (res ? '__unassigned__' : '__not_in_inventory__');
          label = res?.owner ?? (res ? 'Unassigned' : 'Not in inventory');
        } else {
          const v = tagKey ? tagOf(res, tagKey) : null;
          key = v ?? (res ? '__untagged__' : '__not_in_inventory__');
          label = v ?? (res ? `No ${tagKey || 'tag'}` : 'Not in inventory');
        }
        const cur = totals.get(key) ?? { label, cost: 0 };
        cur.cost += r._sum.cost ?? 0;
        totals.set(key, cur);
      }
      return sortRows([...totals.entries()].map(([key, v]) => row(groupBy, key, v.label, null, v.cost))).slice(0, 100);
    }
    if (groupBy === 'subscription') {
      const rows = await this.repo.groupBySubscription(where);
      return sortRows(
        rows.map((r) => {
          const ext = r.subscriptionExternalId ?? '';
          const sub = ext ? idx.subByExt.get(ext) : undefined;
          return row('subscription', ext, sub?.name ?? (ext || 'unknown'), sub?.id ?? null, r._sum.cost);
        }),
      );
    }
    if (groupBy === 'organization') {
      const rows = await this.repo.groupBySubscription(where);
      const orgTotals = new Map<string, { label: string; id: string | null; cost: number }>();
      for (const r of rows) {
        const sub = r.subscriptionExternalId ? idx.subByExt.get(r.subscriptionExternalId) : undefined;
        const key = sub?.tenantId ?? 'unattributed';
        const label = sub?.tenantName ?? 'Unattributed';
        const cur = orgTotals.get(key) ?? { label, id: sub?.tenantId ?? null, cost: 0 };
        cur.cost += r._sum.cost ?? 0;
        orgTotals.set(key, cur);
      }
      return sortRows(
        [...orgTotals.entries()].map(([key, v]) => row('organization', key, v.label, v.id, v.cost)),
      );
    }
    if (groupBy === 'resourceGroup') {
      const rows = await this.repo.groupByResourceGroup(where);
      return sortRows(
        rows
          .filter((r) => r.resourceGroupExternalId)
          .map((r) => {
            const ext = r.resourceGroupExternalId as string;
            const rg = idx.rgByExt.get(ext);
            return row('resourceGroup', ext, rg?.name ?? basename(ext), rg?.id ?? null, r._sum.cost);
          }),
      );
    }
    // resource
    const rows = await this.repo.groupByResource(where);
    return sortRows(
      rows.map((r) => {
        const ext = r.resourceExternalId;
        const res = idx.resourceByExt.get(ext);
        return row('resource', ext, res?.name ?? basename(ext), res?.id ?? null, r._sum.cost);
      }),
    ).slice(0, 50);
  }

  // ── Overview: this month, leaks, savings, budgets ────────────────

  /** Subscription external ids (cost filter) + db ids (inventory filter) for a scope; null = everything. */
  private scopeOf(
    subs: Awaited<ReturnType<FinopsRepository['listSubscriptions']>>,
    q: { tenantId?: string; subscriptionId?: string },
  ): { ext: string[]; ids: string[] } | null {
    if (q.subscriptionId) {
      const s = subs.find((x) => x.id === q.subscriptionId);
      return { ext: s ? [s.externalId] : ['__none__'], ids: s ? [s.id] : ['__none__'] };
    }
    if (q.tenantId) {
      const list = subs.filter((x) => x.tenant?.id === q.tenantId);
      return {
        ext: list.length ? list.map((x) => x.externalId) : ['__none__'],
        ids: list.length ? list.map((x) => x.id) : ['__none__'],
      };
    }
    return null;
  }

  private async monthFigures(latest: Date, where: PrismaNS.CostRecordWhereInput) {
    const y = latest.getUTCFullYear();
    const m = latest.getUTCMonth();
    const monthStart = new Date(Date.UTC(y, m, 1));
    const lastMonthStart = new Date(Date.UTC(y, m - 1, 1));
    const daysElapsed = latest.getUTCDate();
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const dayAfterLatest = new Date(latest.getTime() + DAY_MS);
    const sum = async (from: Date, to: Date) =>
      (await this.repo.sumCost({ ...where, date: { gte: from, lt: to } }))._sum.cost ?? 0;
    const [toDate, lastMonthToDate, lastMonthTotal, last7] = await Promise.all([
      sum(monthStart, dayAfterLatest),
      sum(lastMonthStart, new Date(lastMonthStart.getTime() + daysElapsed * DAY_MS)),
      sum(lastMonthStart, monthStart),
      sum(new Date(dayAfterLatest.getTime() - 7 * DAY_MS), dayAfterLatest),
    ]);
    const runRate = last7 / 7;
    return {
      label: monthStart.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      toDate: round(toDate),
      lastMonthToDate: round(lastMonthToDate),
      lastMonthTotal: round(lastMonthTotal),
      runRate: round(runRate),
      forecast: round(toDate + runRate * (daysInMonth - daysElapsed)),
      daysElapsed,
      daysInMonth,
    };
  }

  async overview(q: FinopsScopeQuery): Promise<FinopsOverviewDto> {
    const [latest, subs, { currency }] = await Promise.all([
      this.repo.latestDate(),
      this.repo.listSubscriptions(),
      this.repo.reportingCurrency(),
    ]);
    const scope = this.scopeOf(subs, q);
    if (!latest) {
      return {
        currency,
        latestDate: null,
        month: { label: '', toDate: 0, lastMonthToDate: 0, lastMonthTotal: 0, runRate: 0, forecast: 0, daysElapsed: 0, daysInMonth: 0 },
        unattributed: { total: 0, byReason: [], items: [] },
        savings: { total: 0, count: 0, items: [] },
        budgets: await this.budgetStatuses(null, subs),
      };
    }

    const where: PrismaNS.CostRecordWhereInput = scope ? { subscriptionExternalId: { in: scope.ext } } : {};
    const subName = new Map(subs.map((s) => [s.externalId.toLowerCase(), s.name]));
    const [month, leakRows, savingRows, budgets] = await Promise.all([
      this.monthFigures(latest, where),
      this.repo.unattributed(latest, 30, scope?.ext ?? null),
      this.repo.savings(scope?.ids ?? null),
      this.budgetStatuses(latest, subs),
    ]);

    const items: UnattributedItemDto[] = leakRows.map((r) => {
      const rgm = /\/resourcegroups\/([^/]+)/i.exec(r.id);
      const reason: UnattributedReason =
        r.rid && r.rstate === 'deleted' ? 'deleted' : rgm ? 'not-in-inventory' : 'subscription-level';
      return {
        resourceExternalId: r.id,
        name: r.rname ?? r.id.split('/').pop() ?? r.id,
        type: typeFromId(r.id),
        resourceGroup: rgm?.[1] ?? null,
        subscription: r.sub ? (subName.get(r.sub.toLowerCase()) ?? null) : null,
        reason,
        resourceId: r.rid,
        cost30d: round(r.cost),
        lastCostDate: isoDay(r.last),
      };
    });
    const byReason = (['deleted', 'not-in-inventory', 'subscription-level'] as const)
      .map((reason) => {
        const list = items.filter((i) => i.reason === reason);
        return { reason, cost: round(list.reduce((n, i) => n + i.cost30d, 0)), count: list.length };
      })
      .filter((x) => x.count > 0);

    // One line per finding; the saving counts each resource once.
    const seen = new Set<string>();
    let savingsTotal = 0;
    for (const r of savingRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      savingsTotal += r.cost ?? 0;
    }

    return {
      currency,
      latestDate: isoDay(latest),
      month,
      unattributed: { total: round(items.reduce((n, i) => n + i.cost30d, 0)), byReason, items: items.slice(0, 50) },
      savings: {
        total: round(savingsTotal),
        count: seen.size,
        items: savingRows.slice(0, 50).map((r) => ({
          resourceId: r.id,
          name: r.name,
          type: r.type,
          finding: r.rule ?? 'Cost finding',
          detail: r.detail,
          costMonthly: round(r.cost ?? 0),
        })),
      },
      budgets,
    };
  }

  // ── Budgets ──────────────────────────────────────────────────────

  private async budgetStatuses(
    latest: Date | null,
    subs: Awaited<ReturnType<FinopsRepository['listSubscriptions']>>,
  ): Promise<BudgetStatusDto[]> {
    const budgets = await this.repo.listBudgets();
    const out: BudgetStatusDto[] = [];
    for (const b of budgets) {
      const scopeType = b.scopeType as BudgetScope;
      let where: PrismaNS.CostRecordWhereInput = {};
      let scopeName = 'All spend';
      if (scopeType === 'organization' && b.scopeId) {
        const list = subs.filter((s) => s.tenant?.id === b.scopeId);
        where = { subscriptionExternalId: { in: list.length ? list.map((s) => s.externalId) : ['__none__'] } };
        scopeName = list[0]?.tenant?.name ?? 'Organization';
      } else if (scopeType === 'subscription' && b.scopeId) {
        const s = subs.find((x) => x.id === b.scopeId);
        where = { subscriptionExternalId: s?.externalId ?? '__none__' };
        scopeName = s?.name ?? 'Subscription';
      } else if (scopeType === 'resourceGroup' && b.scopeId) {
        const rg = await this.repo.resourceGroupExternalId(b.scopeId);
        where = { resourceGroupExternalId: rg?.externalId.toLowerCase() ?? '__none__' };
        scopeName = rg?.name ?? 'Resource group';
      }
      const m = latest ? await this.monthFigures(latest, where) : null;
      const spent = m?.toDate ?? 0;
      const forecast = m?.forecast ?? 0;
      const percentUsed = b.amount > 0 ? Math.round((spent / b.amount) * 100) : 0;
      const forecastPercent = b.amount > 0 ? Math.round((forecast / b.amount) * 100) : 0;
      out.push({
        id: b.id,
        name: b.name,
        scopeType,
        scopeId: b.scopeId,
        scopeName,
        amount: b.amount,
        alertPercent: b.alertPercent,
        spent,
        forecast,
        percentUsed,
        forecastPercent,
        status: spent > b.amount ? 'over' : forecastPercent >= b.alertPercent ? 'at-risk' : 'ok',
      });
    }
    return out;
  }

  private validateBudgetScope(input: BudgetInput): void {
    if (input.scopeType !== 'all' && !input.scopeId) throw AppError.badRequest('Choose which scope the budget covers.');
  }

  async createBudget(input: BudgetInput, actor: AuditActor | null) {
    this.validateBudgetScope(input);
    const b = await this.repo.createBudget({
      name: input.name,
      scopeType: input.scopeType,
      scopeId: input.scopeType === 'all' ? null : (input.scopeId ?? null),
      amount: input.amount,
      alertPercent: input.alertPercent,
      createdById: actor?.id ?? null,
      createdBy: actor?.name ?? null,
    });
    await this.audit?.record({ action: 'finops.budget.create', entity: 'budget', entityId: b.id, actor, metadata: { ...input } });
    return b;
  }

  async updateBudget(id: string, input: BudgetInput, actor: AuditActor | null) {
    if (!(await this.repo.getBudget(id))) throw AppError.notFound('Budget not found');
    this.validateBudgetScope(input);
    const b = await this.repo.updateBudget(id, {
      name: input.name,
      scopeType: input.scopeType,
      scopeId: input.scopeType === 'all' ? null : (input.scopeId ?? null),
      amount: input.amount,
      alertPercent: input.alertPercent,
    });
    await this.audit?.record({ action: 'finops.budget.update', entity: 'budget', entityId: id, actor, metadata: { ...input } });
    return b;
  }

  async deleteBudget(id: string, actor: AuditActor | null) {
    const b = await this.repo.getBudget(id);
    if (!b) throw AppError.notFound('Budget not found');
    await this.repo.deleteBudget(id);
    await this.audit?.record({ action: 'finops.budget.delete', entity: 'budget', entityId: id, actor, metadata: { name: b.name } });
  }

  async resourceTrend(id: string): Promise<ResourceCostTrendDto> {
    const resource = await this.repo.findResourceById(id);
    if (!resource) throw AppError.notFound('Resource not found');
    const cutoff = new Date(Date.now() - this.windowDays * DAY_MS);
    const rows = await this.repo.resourceTrend(resource.externalId.toLowerCase(), cutoff);
    const points = rows.map((r) => ({ date: isoDay(r.date), cost: round(r.cost) }));
    return {
      currency: (await this.repo.reportingCurrency()).currency,
      points,
      totalWindow: round(points.reduce((sum, p) => sum + p.cost, 0)),
      costDaily: resource.costDaily,
      costMonthly: resource.costMonthly,
    };
  }
}

/** Per-subscription outcomes of a finished run; null for runs from before they were recorded. */
function resultsOf(j: Job<FinopsJobData>): CostSyncSubscriptionResultDto[] | null {
  const results = (j.returnvalue as { results?: unknown } | null | undefined)?.results;
  return Array.isArray(results) ? (results as CostSyncSubscriptionResultDto[]) : null;
}

/** Project a BullMQ cost-sync job to the wire DTO (status inferred from timing). */
function toCostSyncDto(j: Job<FinopsJobData>): CostSyncRunDto {
  const status: CostSyncStatus = j.failedReason
    ? 'failed'
    : j.finishedOn
      ? 'completed'
      : j.processedOn
        ? 'running'
        : 'queued';
  const ret = (j.returnvalue ?? undefined) as
    | { records?: number; subscriptions?: number; skipped?: number }
    | undefined;
  const done = status === 'completed';
  return {
    id: String(j.id ?? ''),
    status,
    days: j.data?.days ?? null,
    records: done ? (ret?.records ?? 0) : null,
    subscriptions: done ? (ret?.subscriptions ?? 0) : null,
    skipped: done ? (ret?.skipped ?? 0) : null,
    results: done ? resultsOf(j) : null,
    retryAttempt: j.data?.retryAttempt ?? 0,
    error: j.failedReason ?? null,
    queuedAt: j.timestamp ? new Date(j.timestamp).toISOString() : null,
    startedAt: j.processedOn ? new Date(j.processedOn).toISOString() : null,
    finishedAt: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
  };
}

function row(
  scopeType: FinopsGroupBy,
  key: string,
  label: string,
  scopeId: string | null,
  cost: number | null,
): FinopsBreakdownRow {
  return { key, label, scopeType, scopeId, cost: round(cost ?? 0) };
}
function sortRows(rows: FinopsBreakdownRow[]): FinopsBreakdownRow[] {
  return rows.sort((a, b) => b.cost - a.cost);
}

function defaultGranularity(days: number): FinopsGranularity {
  if (days <= 31) return 'day';
  if (days <= 93) return 'week';
  return 'month';
}

/** Resolve a preset or custom range → concrete UTC [fromDate, toDate) (to exclusive). */
function resolveRange(q: FinopsQuery): { fromDate: Date; toDate: Date; days: number } {
  const presetDays: Record<string, number> = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 };
  if (q.preset === 'custom' && q.from && q.to) {
    const fromDate = utcMidnight(new Date(q.from));
    // 'to' is an inclusive day → make exclusive by advancing one day.
    const toDate = new Date(utcMidnight(new Date(q.to)).getTime() + DAY_MS);
    const days = Math.max(1, Math.round((toDate.getTime() - fromDate.getTime()) / DAY_MS));
    return { fromDate, toDate, days };
  }
  const days = presetDays[q.preset] ?? 30;
  const toDate = new Date(utcMidnight(new Date()).getTime() + DAY_MS); // include today
  const fromDate = new Date(toDate.getTime() - days * DAY_MS);
  return { fromDate, toDate, days };
}
