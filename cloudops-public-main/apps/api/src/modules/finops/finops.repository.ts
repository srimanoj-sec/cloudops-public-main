import { Prisma as PrismaNS } from '@prisma/client';
import { config } from '../../env.js';
import type { Prisma } from '../../infra/prisma.js';

export interface CostRow {
  providerKey: string;
  resourceExternalId: string;
  subscriptionExternalId: string;
  resourceGroupExternalId: string | null;
  resourceId: string | null;
  date: Date;
  cost: number;
  currency: string;
  originalCost?: number | null;
  originalCurrency?: string | null;
  fxRate?: number | null;
}

type Where = PrismaNS.CostRecordWhereInput;

/** Library rules whose failures are money you can stop spending (the savings panel). */
const SAVINGS_TEMPLATES = [
  'unattached-disk',
  'unassociated-public-ip',
  'orphaned-nic',
  'vm-stopped-not-deallocated',
  'empty-app-service-plan',
  'plan-apps-all-stopped',
  'nonprod-no-premium-sku',
];

/** Data-access for cost sync (writes) and the FinOps cost explorer (aggregations). */
export class FinopsRepository {
  constructor(private readonly prisma: Prisma) {}

  // ── sync writes ────────────────────────────────────────────────
  /** Subscriptions with their org (Tenant) for scope resolution + labels. */
  listSubscriptions() {
    return this.prisma.subscription.findMany({
      select: { id: true, externalId: true, name: true, state: true, tenant: { select: { id: true, name: true } } },
    });
  }

  /** The most recent day with stored cost, per subscription (provider id). */
  async lastCostDates(): Promise<Map<string, Date>> {
    const rows = await this.prisma.costRecord.groupBy({ by: ['subscriptionExternalId'], _max: { date: true } });
    const out = new Map<string, Date>();
    for (const r of rows) if (r.subscriptionExternalId && r._max.date) out.set(r.subscriptionExternalId, r._max.date);
    return out;
  }

  resourceIndex() {
    return this.prisma.resource.findMany({
      select: { id: true, externalId: true, name: true, type: true, state: true, owner: true, tags: true, platformTags: true },
    });
  }

  resourceGroupIndex() {
    return this.prisma.resourceGroup.findMany({
      select: { id: true, externalId: true, name: true },
    });
  }

  /**
   * Atomically replace one subscription's cost window: the delete and the
   * re-insert commit together, so a failure mid-sync never leaves the window
   * empty (readers see the old data until the new data is complete).
   */
  /** Currencies present in stored cost that aren't the reporting currency (legacy/unconverted rows). */
  async foreignCurrencies(reporting: string): Promise<string[]> {
    const rows = await this.prisma.costRecord.findMany({
      where: { currency: { not: reporting } },
      distinct: ['currency'],
      select: { currency: true },
    });
    return rows.map((r) => r.currency);
  }

  /** Convert every stored row in `from` into `to` at `rate`, keeping the original amount. */
  convertStoredCurrency(from: string, to: string, rate: number): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "CostRecord"
      SET "originalCost" = "cost", "originalCurrency" = "currency", "fxRate" = ${rate},
          "cost" = "cost" * ${rate}, "currency" = ${to}
      WHERE "currency" = ${from}`;
  }

  replaceCostWindow(subscriptionExternalId: string, from: Date, to: Date, rows: CostRow[]) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.costRecord.deleteMany({ where: { subscriptionExternalId, date: { gte: from, lte: to } } });
        await tx.costRecord.createMany({ data: rows, skipDuplicates: true });
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Recompute every resource's cost rollups from CostRecord in one transaction:
   *  - costMonthly = actual spend over the trailing {@link days} days ending at
   *    the newest cost date (Cost Management lags ~1-2 days, so "now" would
   *    under-count), i.e. "what this resource cost in the last month";
   *  - costDaily   = costMonthly / days (average daily spend over that month).
   * Resources with no cost in the window are reset to null.
   *
   * Set-based SQL instead of one UPDATE per resource.
   */
  async recomputeRollups(days = 30): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          UPDATE "Resource" SET "costDaily" = NULL, "costMonthly" = NULL
          WHERE "costDaily" IS NOT NULL OR "costMonthly" IS NOT NULL`;
        return tx.$executeRaw`
          WITH latest AS (SELECT max("date") AS d FROM "CostRecord"),
          agg AS (
            SELECT c."resourceId" AS id, sum(c."cost") AS total
            FROM "CostRecord" c, latest
            WHERE c."resourceId" IS NOT NULL
              AND c."date" > latest.d - make_interval(days => ${days}::int)
            GROUP BY c."resourceId"
          )
          UPDATE "Resource" r
          SET "costMonthly" = agg.total, "costDaily" = agg.total / ${days}::int
          FROM agg WHERE r.id = agg.id`;
      },
      { timeout: 60_000 },
    );
  }

  // ── cost explorer aggregations (all take a dynamic where) ───────
  sumCost(where: Where) {
    return this.prisma.costRecord.aggregate({ where, _sum: { cost: true } });
  }

  groupByDate(where: Where) {
    return this.prisma.costRecord.groupBy({
      by: ['date'],
      where,
      _sum: { cost: true },
      orderBy: { date: 'asc' },
    });
  }

  groupBySubscription(where: Where) {
    return this.prisma.costRecord.groupBy({ by: ['subscriptionExternalId'], where, _sum: { cost: true } });
  }

  groupByResourceGroup(where: Where) {
    return this.prisma.costRecord.groupBy({ by: ['resourceGroupExternalId'], where, _sum: { cost: true } });
  }

  groupByResource(where: Where) {
    return this.prisma.costRecord.groupBy({ by: ['resourceExternalId'], where, _sum: { cost: true } });
  }

  /** Per-resource, per-day cost totals — the raw series for spike detection. */
  dailyCostByResource(where: Where) {
    return this.prisma.costRecord.groupBy({
      by: ['resourceExternalId', 'date'],
      where,
      _sum: { cost: true },
    });
  }

  /**
   * Spend per resource region: the latest day vs the baseline days before it
   * (only resources the cost is matched to). Drives "new region" anomalies.
   */
  async costByLocation(windowStart: Date, latest: Date, subscriptionExternalIds: string[] | null) {
    const scope = subscriptionExternalIds ?? [];
    return this.prisma.$queryRaw<{ location: string; latest: number; prior: number }[]>`
      SELECT r.location,
             coalesce(sum(CASE WHEN c."date" = ${latest} THEN c.cost END), 0)::float AS latest,
             coalesce(sum(CASE WHEN c."date" < ${latest} THEN c.cost END), 0)::float AS prior
      FROM "CostRecord" c JOIN "Resource" r ON r.id = c."resourceId"
      WHERE c."date" >= ${windowStart} AND c."date" <= ${latest} AND r.location IS NOT NULL
        AND (${subscriptionExternalIds === null} OR c."subscriptionExternalId" = ANY(${scope}::text[]))
      GROUP BY r.location`;
  }

  /** Total cost of one day (optionally scoped) — the base for "is this increase material?". */
  async dayTotal(day: Date, subscriptionExternalIds: string[] | null): Promise<number> {
    const r = await this.prisma.costRecord.aggregate({
      _sum: { cost: true },
      where: { date: day, ...(subscriptionExternalIds ? { subscriptionExternalId: { in: subscriptionExternalIds } } : {}) },
    });
    return r._sum.cost ?? 0;
  }

  /** Inventory context for flagged cost keys (lower-cased external ids). */
  async resourcesForCostKeys(keys: string[], day: Date) {
    if (keys.length === 0) return [];
    const links = await this.prisma.costRecord.findMany({
      where: { resourceExternalId: { in: keys }, date: day, resourceId: { not: null } },
      select: { resourceExternalId: true, resourceId: true },
      distinct: ['resourceExternalId'],
    });
    const rows = await this.prisma.resource.findMany({
      where: { id: { in: links.map((l) => l.resourceId!) } },
      select: {
        id: true,
        name: true,
        type: true,
        location: true,
        resourceGroup: { select: { name: true } },
        subscription: { select: { name: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return links.flatMap((l) => {
      const r = byId.get(l.resourceId!);
      return r ? [{ key: l.resourceExternalId, ...r }] : [];
    });
  }

  /** The most recent day cost data covers, or null when there is none. */
  async latestDate(): Promise<Date | null> {
    const r = await this.prisma.costRecord.aggregate({ _max: { date: true } });
    return r._max.date ?? null;
  }

  /**
   * The currency every stored amount is in (COST_CURRENCY). Deliberately not
   * read from the data: "the latest record's currency" is arbitrary when two
   * billing accounts use different currencies.
   */
  async reportingCurrency(): Promise<{ currency: string }> {
    return { currency: config.COST_CURRENCY };
  }

  async earliestDate(): Promise<Date | null> {
    const r = await this.prisma.costRecord.aggregate({ _min: { date: true } });
    return r._min.date ?? null;
  }

  // ── overview ────────────────────────────────────────────────────

  /**
   * Cost in the trailing window that isn't on an active inventory resource —
   * deleted resources still billing, resources never discovered, and
   * subscription-level services — per billed resource id.
   */
  unattributed(latest: Date, days: number, subscriptionExternalIds: string[] | null) {
    const scope = subscriptionExternalIds
      ? PrismaNS.sql`AND c."subscriptionExternalId" = ANY(${subscriptionExternalIds}::text[])`
      : PrismaNS.empty;
    return this.prisma.$queryRaw<
      { id: string; sub: string | null; cost: number; last: Date; rid: string | null; rstate: string | null; rname: string | null }[]
    >`
      SELECT c."resourceExternalId" AS id, c."subscriptionExternalId" AS sub, sum(c.cost)::float AS cost, max(c.date) AS last,
             max(r.id) AS rid, max(r.state::text) AS rstate, max(r.name) AS rname
      FROM "CostRecord" c LEFT JOIN "Resource" r ON r.id = c."resourceId"
      WHERE c.date > ${latest}::timestamp - make_interval(days => ${days}::int)
        AND (c."resourceId" IS NULL OR r.state = 'deleted') ${scope}
      GROUP BY c."resourceExternalId", c."subscriptionExternalId"
      HAVING sum(c.cost) > 0
      ORDER BY cost DESC`;
  }

  /** Active resources failing an enabled cost-optimization rule, with their monthly cost. */
  savings(subscriptionIds: string[] | null) {
    const scope = subscriptionIds ? PrismaNS.sql`AND res."subscriptionId" = ANY(${subscriptionIds}::text[])` : PrismaNS.empty;
    return this.prisma.$queryRaw<
      { id: string; name: string; type: string; cost: number | null; rule: string | null; detail: string | null }[]
    >`
      SELECT res.id, res.name, res.type, res."costMonthly" AS cost, COALESCE(r.name, r.description) AS rule, c.detail
      FROM "ComplianceResult" c
      JOIN "StandardRule" r ON r.id = c."ruleId"
      JOIN "Resource" res ON res.id = c."scopeId"
      WHERE c."scopeType" = 'resource' AND r.enabled
        AND (r.template = ANY(${SAVINGS_TEMPLATES}::text[]) OR (r.template IS NULL AND r.category = 'cost'))
        AND NOT c.passed AND NOT c.exempt AND res.state = 'active' ${scope}
      ORDER BY res."costMonthly" DESC NULLS LAST`;
  }

  // ── budgets ─────────────────────────────────────────────────────
  listBudgets() {
    return this.prisma.budget.findMany({ orderBy: { createdAt: 'asc' } });
  }
  createBudget(data: PrismaNS.BudgetCreateInput) {
    return this.prisma.budget.create({ data });
  }
  getBudget(id: string) {
    return this.prisma.budget.findUnique({ where: { id } });
  }
  updateBudget(id: string, data: PrismaNS.BudgetUpdateInput) {
    return this.prisma.budget.update({ where: { id }, data });
  }
  deleteBudget(id: string) {
    return this.prisma.budget.delete({ where: { id } });
  }
  resourceGroupExternalId(id: string) {
    return this.prisma.resourceGroup.findUnique({ where: { id }, select: { externalId: true, name: true } });
  }

  // ── per-resource trend (resource detail Cost tab) ──────────────
  resourceTrend(externalIdLower: string, cutoff: Date) {
    return this.prisma.costRecord.findMany({
      where: { resourceExternalId: externalIdLower, date: { gte: cutoff } },
      select: { date: true, cost: true, currency: true },
      orderBy: { date: 'asc' },
    });
  }

  findResourceById(id: string) {
    return this.prisma.resource.findFirst({
      where: { OR: [{ id }, { externalId: id }] },
      select: { id: true, externalId: true, costDaily: true, costMonthly: true },
    });
  }
}
