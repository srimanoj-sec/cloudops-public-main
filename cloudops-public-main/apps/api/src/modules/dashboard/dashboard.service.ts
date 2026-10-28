import type {
  CountBucket,
  DashboardOverview,
  DashboardSummary,
  HealthComponentDto,
  InsightDto,
  TopSpenderDto,
} from '@cloudops/core';
import { formatMoney } from '@cloudops/core';
import { config } from '../../env.js';
import type { Prisma } from '../../infra/prisma.js';
import type { StandardsService } from '../standards/standards.service.js';
import type { WorkService } from '../work/work.service.js';
import { ROLLUP_DAYS } from '../finops/finops.engine.js';
import type { PriorityService } from './priority.service.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Compact money label, e.g. ₹812k, $1.2M — currency prefix is best-effort. */
function money(amount: number, currency: string): string {
  return formatMoney(amount, currency, { compact: true });
}
/**
 * Read-optimized dashboard queries (a light CQRS read model). All reads hit
 * Postgres only — the dashboard works fully offline after a sync. The overview
 * composes the standards + work read models with inventory/cost aggregates.
 */
export class DashboardService {
  constructor(
    private readonly prisma: Prisma,
    private readonly standards: StandardsService,
    private readonly work: WorkService,
    private readonly priority: PriorityService,
  ) {}

  /** @param tenantId optional organization scope (from the global org switcher). */
  async summary(tenantId?: string): Promise<DashboardSummary> {
    // Scope resources/RGs by their subscription's tenant; subscriptions by tenant.
    const resourceScope = tenantId ? { subscription: { tenantId } } : {};
    const subScope = tenantId ? { tenantId } : {};

    const [organizations, subscriptions, resourceGroups, resources, byType, byLocation, latestSync, subsForBuckets, lastCompleted] =
      await Promise.all([
        tenantId ? Promise.resolve(1) : this.prisma.tenant.count(),
        this.prisma.subscription.count({ where: subScope }),
        this.prisma.resourceGroup.count({ where: resourceScope }),
        this.prisma.resource.count({ where: { state: 'active', ...resourceScope } }),
        this.prisma.resource.groupBy({
          by: ['type'],
          where: { state: 'active', ...resourceScope },
          _count: { _all: true },
          orderBy: { _count: { type: 'desc' } },
          take: 12,
        }),
        this.prisma.resource.groupBy({
          by: ['location'],
          where: { state: 'active', location: { not: null }, ...resourceScope },
          _count: { _all: true },
          orderBy: { _count: { location: 'desc' } },
          take: 12,
        }),
        this.prisma.syncRun.findFirst({ orderBy: { createdAt: 'desc' } }),
        this.prisma.subscription.findMany({
          where: subScope,
          select: {
            name: true,
            tenant: { select: { name: true } },
            _count: { select: { resources: { where: { state: 'active' } } } },
          },
          orderBy: { name: 'asc' },
        }),
        this.prisma.syncRun.findFirst({
          where: { status: 'completed' },
          orderBy: { finishedAt: 'desc' },
          select: { finishedAt: true },
        }),
      ]);

    const distinctTypes = new Set(byType.map((b) => b.type)).size;
    const distinctLocations = byLocation.length;

    const resourcesByType: CountBucket[] = byType.map((b) => ({ label: b.type, count: b._count._all }));
    const resourcesByLocation: CountBucket[] = byLocation.map((b) => ({
      label: b.location ?? 'unknown',
      count: b._count._all,
    }));
    const resourcesBySubscription: CountBucket[] = subsForBuckets.map((s) => ({
      label: s.name,
      count: s._count.resources,
    }));

    // Roll subscription counts up to their organization (Tenant).
    const orgTotals = new Map<string, number>();
    for (const s of subsForBuckets) {
      const label = s.tenant?.name ?? 'Unattributed';
      orgTotals.set(label, (orgTotals.get(label) ?? 0) + s._count.resources);
    }
    const resourcesByOrganization: CountBucket[] = [...orgTotals.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    return {
      kpis: {
        organizations,
        subscriptions,
        resourceGroups,
        resources,
        distinctTypes,
        distinctLocations,
        lastSyncAt: latestSync?.createdAt.toISOString() ?? null,
        lastSyncStatus: latestSync?.status ?? null,
        offlineReady: resources > 0,
        lastCompletedSyncAt: lastCompleted?.finishedAt?.toISOString() ?? null,
      },
      resourcesByType,
      resourcesByLocation,
      resourcesBySubscription,
      resourcesByOrganization,
    };
  }

  /**
   * The Operations Command Center payload — health, cost, compliance, work, and
   * "needs attention" insights composed from every module's read model.
   * @param tenantId optional organization scope. NOTE: compliance is scored
   * estate-wide today (not yet per-org), and is flagged as such in the response.
   */
  /**
   * Cost in the same trailing-30-day window as the resource rollups that isn't
   * on an active inventory resource (never discovered, or deleted but billing). Hiding it would understate spend
   * (and hide leaks such as deleted-but-still-billing resource groups).
   */
  private async unattributedCost(tenantId?: string): Promise<number> {
    const rows = tenantId
      ? await this.prisma.$queryRaw<{ total: number | null }[]>`
          WITH latest AS (SELECT max("date") AS d FROM "CostRecord")
          SELECT sum(c."cost")::float AS total FROM "CostRecord" c CROSS JOIN latest LEFT JOIN "Resource" r ON r.id = c."resourceId"
          WHERE (c."resourceId" IS NULL OR r.state = 'deleted') AND c."date" > latest.d - make_interval(days => ${ROLLUP_DAYS}::int)
            AND lower(c."subscriptionExternalId") IN (
              SELECT lower(s."externalId") FROM "Subscription" s WHERE s."tenantId" = ${tenantId})`
      : await this.prisma.$queryRaw<{ total: number | null }[]>`
          WITH latest AS (SELECT max("date") AS d FROM "CostRecord")
          SELECT sum(c."cost")::float AS total FROM "CostRecord" c CROSS JOIN latest LEFT JOIN "Resource" r ON r.id = c."resourceId"
          WHERE (c."resourceId" IS NULL OR r.state = 'deleted') AND c."date" > latest.d - make_interval(days => ${ROLLUP_DAYS}::int)`;
    return rows[0]?.total ?? 0;
  }

  async overview(tenantId?: string): Promise<DashboardOverview> {
    const resourceScope = tenantId ? { subscription: { tenantId } } : {};
    const base = await this.summary(tenantId);
    const resources = base.kpis.resources;

    const [
      ownerHave,
      costAgg,
      topSpenderRows,
      latestCost,
      noOwner,
      idleCosting,
      idleCostingAgg,
      missingCost,
      driftRows,
      compliance,
      workSummary,
    ] = await Promise.all([
      this.prisma.resource.count({ where: { state: 'active', owner: { not: null }, ...resourceScope } }),
      this.prisma.resource.aggregate({
        _sum: { costMonthly: true, costDaily: true },
        where: { state: 'active', ...resourceScope },
      }),
      this.prisma.resource.findMany({
        where: { state: 'active', costMonthly: { gt: 0 }, ...resourceScope },
        orderBy: { costMonthly: 'desc' },
        take: 5,
        select: { id: true, name: true, type: true, costMonthly: true },
      }),
      Promise.resolve({ currency: config.COST_CURRENCY }),
      this.prisma.resource.count({ where: { state: 'active', owner: null, ...resourceScope } }),
      this.prisma.resource.count({ where: { state: 'active', inUse: false, costMonthly: { gt: 0 }, ...resourceScope } }),
      this.prisma.resource.aggregate({
        _sum: { costMonthly: true },
        where: { state: 'active', inUse: false, costMonthly: { gt: 0 }, ...resourceScope },
      }),
      this.prisma.resource.count({ where: { state: 'active', costMonthly: null, ...resourceScope } }),
      this.prisma.changeEvent.findMany({
        where: tenantId ? { resource: { subscription: { tenantId } } } : {},
        orderBy: { detectedAt: 'desc' },
        take: 8,
        include: { resource: { select: { id: true, name: true } } },
      }),
      this.standards.summary(),
      this.work.summary({ tenantId }),
    ]);
    const unattributed = await this.unattributedCost(tenantId);

    const currency = latestCost.currency;
    const costMonthly = costAgg._sum.costMonthly ?? 0;
    const costDaily = costAgg._sum.costDaily ?? 0;
    const withCost = Math.max(0, resources - missingCost);
    const ownershipCoverage = resources > 0 ? Math.round((ownerHave / resources) * 100) : 0;
    const costCoverage = resources > 0 ? Math.round((withCost / resources) * 100) : 0;
    const complianceScore = compliance.totalChecks > 0 ? compliance.score : null;

    // Composite health = mean of the signals that actually have data.
    const signals = [ownershipCoverage, costCoverage];
    if (complianceScore != null) signals.unshift(complianceScore);
    const health = signals.length ? Math.round(signals.reduce((a, b) => a + b, 0) / signals.length) : 0;
    const highFailing = compliance.bySeverity.find((b) => b.severity === 'high')?.failed ?? 0;
    const components: HealthComponentDto[] = [
      ...(complianceScore != null
        ? [
            {
              key: 'compliance' as const,
              label: 'Compliance',
              score: complianceScore,
              detail: compliance.failed
                ? `${compliance.failed} failing checks${highFailing ? `, ${highFailing} high severity` : ''} (weighted by severity).`
                : 'Every applicable check passes.',
              link: '/standards',
            },
          ]
        : []),
      {
        key: 'ownership',
        label: 'Ownership',
        score: ownershipCoverage,
        detail: noOwner ? `${noOwner} of ${resources} resources have no owner tag.` : 'Every resource has an owner.',
        link: '/inventory?owners=__unassigned__',
      },
      {
        key: 'cost-visibility',
        label: 'Cost visibility',
        score: costCoverage,
        detail: missingCost
          ? `${missingCost} resources have no cost data — free services, or subscriptions the cost sync can't read.`
          : 'Every resource has cost data.',
        link: '/finops?tab=sync',
      },
    ];
    const { priorities, costInsights, urgentWork } = await this.priority.compute(tenantId, costMonthly + unattributed);

    const topFailing = compliance.standards
      .flatMap((s) =>
        s.rules
          .filter((r) => r.failed > 0)
          .map((r) => ({ id: r.id, name: r.name, standardName: s.name, severity: r.severity, failed: r.failed })),
      )
      .sort((a, b) => b.failed - a.failed)
      .slice(0, 5);

    const topSpenders: TopSpenderDto[] = topSpenderRows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      monthly: round2(r.costMonthly ?? 0),
    }));

    const idleSum = idleCostingAgg._sum.costMonthly ?? 0;
    const insights: InsightDto[] = [];
    if (noOwner > 0)
      insights.push({ key: 'no-owner', label: 'Resources without an owner', count: noOwner, detail: null, to: '/inventory', tone: 'amber' });
    if (idleCosting > 0)
      insights.push({
        key: 'idle-costing',
        label: 'Idle but still costing',
        count: idleCosting,
        detail: idleSum > 0 ? `${money(idleSum, currency)}/mo` : null,
        to: '/finops',
        tone: 'red',
      });
    if (missingCost > 0)
      insights.push({ key: 'missing-cost', label: 'No cost data', count: missingCost, detail: 'run a FinOps sync', to: '/finops', tone: 'slate' });
    if (compliance.failed > 0)
      insights.push({ key: 'failing-checks', label: 'Failing compliance checks', count: compliance.failed, detail: 'estate-wide', to: '/standards', tone: 'amber' });
    if (workSummary.overdue > 0)
      insights.push({ key: 'overdue-work', label: 'Overdue work items', count: workSummary.overdue, detail: null, to: '/work', tone: 'red' });

    // Freshness is judged by the last sync that actually COMPLETED — a failed or
    // still-queued run must not make a day-old estate look current.
    const lastSyncAt = base.kpis.lastCompletedSyncAt ?? null;
    const stale = !lastSyncAt || Date.now() - new Date(lastSyncAt).getTime() > 24 * 60 * 60 * 1000;

    return {
      kpis: base.kpis,
      health: { score: health, complianceScore, ownershipCoverage, costCoverage, components },
      priorities,
      costInsights,
      urgentWork,
      cost: {
        currency,
        monthlyProjected: round2(costMonthly),
        unattributedMonthly: round2(unattributed),
        dailyAvg: round2(costDaily),
        topSpenders,
        hasData: costMonthly > 0 || costDaily > 0 || unattributed > 0,
      },
      compliance: {
        evaluatedAt: compliance.evaluatedAt,
        score: compliance.score,
        passed: compliance.passed,
        failed: compliance.failed,
        bySeverity: compliance.bySeverity,
        topFailing,
        estateWide: true,
      },
      work: {
        open: workSummary.total - workSummary.byState.done,
        overdue: workSummary.overdue,
        inProgress: workSummary.byState.in_progress,
        blocked: workSummary.byState.blocked,
        done: workSummary.byState.done,
      },
      insights,
      drift: driftRows.map((d) => ({
        id: d.id,
        resourceId: d.resource?.id ?? d.resourceId,
        resourceName: d.resource?.name ?? null,
        field: d.field,
        detectedAt: d.detectedAt.toISOString(),
      })),
      resourcesByType: base.resourcesByType,
      resourcesByOrganization: base.resourcesByOrganization,
      sync: { lastSyncAt, lastSyncStatus: base.kpis.lastSyncStatus, stale },
    };
  }
}
