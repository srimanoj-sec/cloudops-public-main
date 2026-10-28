import type { $Enums, Prisma as PrismaNS } from '@prisma/client';
import { categoryForType, type InventoryGroupBy, type ResourceQuery } from '@cloudops/core';
import { config } from '../../env.js';
import type { Prisma } from '../../infra/prisma.js';

/**
 * Columns a resource list/row needs — everything except the (large, unused in
 * lists) `properties` JSON blob, which can be kilobytes per resource.
 */
const listSelect = {
  id: true,
  externalId: true,
  name: true,
  type: true,
  providerKey: true,
  location: true,
  sku: true,
  state: true,
  lifecycleStage: true,
  tags: true,
  platformTags: true,
  taggableInAzure: true,
  owner: true,
  azureCreatedAt: true,
  retireBy: true,
  inUse: true,
  costDaily: true,
  costMonthly: true,
  subscriptionId: true,
  resourceGroupId: true,
  lastSyncedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** List columns plus where the resource lives (org › subscription › resource group). */
const listWithContext = {
  ...listSelect,
  subscription: { select: { name: true, tenant: { select: { id: true, name: true } } } },
  resourceGroup: { select: { name: true } },
} as const;

function orderFor(q: ResourceQuery): PrismaNS.ResourceOrderByWithRelationInput[] {
  const dir = q.dir;
  switch (q.sort) {
    case 'type':
      return [{ type: dir }, { name: 'asc' }, { id: 'asc' }];
    case 'location':
      return [{ location: { sort: dir, nulls: 'last' } }, { name: 'asc' }, { id: 'asc' }];
    case 'cost':
      return [{ costMonthly: { sort: dir, nulls: 'last' } }, { name: 'asc' }, { id: 'asc' }];
    case 'created':
      return [{ azureCreatedAt: { sort: dir, nulls: 'last' } }, { name: 'asc' }, { id: 'asc' }];
    case 'resourceGroup':
      return [{ resourceGroup: { name: dir } }, { name: 'asc' }, { id: 'asc' }];
    default:
      return [{ name: dir }, { id: 'asc' }];
  }
}

export const UNASSIGNED_OWNER = '__unassigned__';

/** Only resources that still exist count toward inventory totals. */
const activeOnly = { where: { state: 'active' as const } };

export class InventoryRepository {
  constructor(private readonly prisma: Prisma) {}

  private buildResourceWhere(q: ResourceQuery): PrismaNS.ResourceWhereInput {
    const where: PrismaNS.ResourceWhereInput = {};
    const and: PrismaNS.ResourceWhereInput[] = [];

    // Multi-select filters take precedence over their legacy single-value form.
    if (q.types?.length) where.type = { in: q.types };
    else if (q.type) where.type = q.type;

    if (q.locations?.length) where.location = { in: q.locations };
    else if (q.location) where.location = q.location;

    if (q.owners?.length) {
      // `__unassigned__` selects resources with no owner (the "Unassigned" group).
      const named = q.owners.filter((o) => o !== UNASSIGNED_OWNER);
      if (q.owners.includes(UNASSIGNED_OWNER)) and.push({ OR: [{ owner: null }, ...(named.length ? [{ owner: { in: named } }] : [])] });
      else where.owner = { in: named };
    } else if (q.owner) where.owner = q.owner;

    if (q.states?.length) where.state = { in: q.states as $Enums.ResourceState[] };
    else if (q.state) where.state = q.state;

    if (q.lifecycleStages?.length) where.lifecycleStage = { in: q.lifecycleStages as $Enums.LifecycleStage[] };

    if (q.subscriptionIds?.length) where.subscriptionId = { in: q.subscriptionIds };
    else if (q.subscriptionId) where.subscriptionId = q.subscriptionId;

    // Organization filter: resources whose subscription belongs to this tenant/org.
    if (q.tenantId) where.subscription = { tenantId: q.tenantId };
    if (q.resourceGroupId) where.resourceGroupId = q.resourceGroupId;

    // Tag filters (`key:value`), AND-combined across the JSON `tags` column.
    for (const t of q.tags ?? []) {
      const idx = t.indexOf(':');
      if (idx <= 0) continue;
      const key = t.slice(0, idx);
      const value = t.slice(idx + 1);
      if (!value) continue;
      and.push({ tags: { path: [key], equals: value } });
    }

    // Fuzzy search (trigram-accelerated ILIKE across the identifying fields).
    if (q.search) {
      and.push({
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { type: { contains: q.search, mode: 'insensitive' } },
          { externalId: { contains: q.search, mode: 'insensitive' } },
          { owner: { contains: q.search, mode: 'insensitive' } },
        ],
      });
    }

    if (and.length) where.AND = and;
    return where;
  }

  /**
   * Category filter → the concrete types in that category (categories are derived
   * from the type's namespace, so they can't be a column filter on their own).
   */
  private async resolveCategories(q: ResourceQuery): Promise<ResourceQuery> {
    if (!q.categories?.length) return q;
    const wanted = new Set(q.categories);
    const all = await this.prisma.resource.findMany({ distinct: ['type'], select: { type: true } });
    let types = all.map((t) => t.type).filter((t) => wanted.has(categoryForType(t)));
    if (q.types?.length) types = types.filter((t) => q.types!.includes(t));
    return { ...q, types: types.length ? types : ['__none__'], type: undefined };
  }

  async whereFor(q: ResourceQuery): Promise<PrismaNS.ResourceWhereInput> {
    return this.buildResourceWhere(await this.resolveCategories(q));
  }

  async listResources(q: ResourceQuery) {
    const where = await this.whereFor(q);
    const [items, total] = await Promise.all([
      this.prisma.resource.findMany({
        where,
        select: listWithContext,
        orderBy: orderFor(q),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.resource.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Stream every resource matching the filters, in stable batches (keyset
   * pagination on id — constant memory for exports of any size).
   */
  async *iterateResources(q: ResourceQuery, batchSize = 1000, limit = 50_000) {
    const where = await this.whereFor(q);
    let cursor: string | undefined;
    let yielded = 0;
    while (yielded < limit) {
      const rows = await this.prisma.resource.findMany({
        where,
        select: {
          ...listSelect,
          subscription: { select: { name: true } },
          resourceGroup: { select: { name: true } },
        },
        orderBy: { id: 'asc' },
        take: Math.min(batchSize, limit - yielded),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) return;
      yielded += rows.length;
      cursor = rows[rows.length - 1]!.id;
      yield rows;
      if (rows.length < batchSize) return;
    }
  }

  getResource(id: string) {
    return this.prisma.resource.findFirst({
      where: { OR: [{ id }, { externalId: id }] },
      include: {
        // Only the other end's identity is shown — not its whole row.
        relationshipsFrom: { include: { target: { select: { id: true, name: true } } } },
        relationshipsTo: { include: { source: { select: { id: true, name: true } } } },
        subscription: { select: { name: true, tenant: { select: { id: true, name: true, externalId: true } } } },
        resourceGroup: { select: { name: true } },
      },
    });
  }

  /**
   * Everything that happened to a resource, from every source — detected
   * changes, lifecycle, tag writes and refreshes, remediations, work items,
   * exemptions. Each query is index-backed and bounded.
   */
  async activityFor(id: string) {
    const [changes, lifecycle, audits, targets, links, exemptions] = await Promise.all([
      this.prisma.changeEvent.findMany({ where: { resourceId: id }, orderBy: { detectedAt: 'desc' }, take: 100 }),
      this.prisma.assetLifecycleEvent.findMany({ where: { resourceId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.auditLog.findMany({
        where: { OR: [{ entity: 'tags', entityId: id }, { entity: 'resource', entityId: id }] },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.remediationTarget.findMany({
        where: { resourceId: id },
        include: { run: { select: { id: true, title: true, status: true, requestedBy: true, executedBy: true, createdAt: true } } },
        orderBy: { run: { createdAt: 'desc' } },
        take: 50,
      }),
      this.prisma.workItemLink.findMany({
        where: { scopeType: 'resource', scopeId: id },
        include: { workItem: { select: { id: true, title: true, state: true, createdAt: true, createdBy: true, type: true } } },
        take: 50,
      }),
      this.prisma.complianceExemption.findMany({
        where: { resourceId: id },
        include: { rule: { select: { name: true, description: true } } },
        take: 50,
      }),
    ]);
    return { changes, lifecycle, audits, targets, links, exemptions };
  }

  listSubscriptions(tenantId?: string) {
    return this.prisma.subscription.findMany({
      where: tenantId ? { tenantId } : undefined,
      orderBy: { name: 'asc' },
      include: {
        tenant: { select: { name: true } },
        _count: { select: { resourceGroups: true, resources: activeOnly } },
      },
    });
  }

  /**
   * Organizations = Tenant rows (one Entra tenant per synced service principal),
   * rolled up with subscription / resource-group / resource counts and the most
   * recent sync time across their subscriptions. Optionally scoped to one org.
   */
  listOrganizations(tenantId?: string) {
    return this.prisma.tenant.findMany({
      where: tenantId ? { id: tenantId } : undefined,
      orderBy: { name: 'asc' },
      include: {
        subscriptions: {
          select: {
            lastSyncedAt: true,
            _count: { select: { resourceGroups: true, resources: activeOnly } },
          },
        },
      },
    });
  }

  listResourceGroups(subscriptionId?: string, tenantId?: string) {
    const where: PrismaNS.ResourceGroupWhereInput = {};
    if (subscriptionId) where.subscriptionId = subscriptionId;
    // Organization scope: resource groups whose subscription belongs to this tenant.
    if (tenantId) where.subscription = { tenantId };
    return this.prisma.resourceGroup.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        subscription: { select: { name: true } },
        _count: { select: { resources: activeOnly } },
      },
    });
  }

  /** Lifecycle timeline + change-event feed for a single resource. */
  async getResourceHistory(id: string) {
    const resource = await this.prisma.resource.findFirst({
      where: { OR: [{ id }, { externalId: id }] },
      select: { id: true },
    });
    if (!resource) return null;
    const [lifecycleEvents, changeEvents] = await Promise.all([
      this.prisma.assetLifecycleEvent.findMany({
        where: { resourceId: resource.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.changeEvent.findMany({
        where: { resourceId: resource.id },
        orderBy: { detectedAt: 'desc' },
        take: 100,
      }),
    ]);
    return { lifecycleEvents, changeEvents };
  }

  // ── Daily-cost rollups (7-day average) ───────────────────────────

  /** Currency of the most recent cost record (uniform across the estate in practice). */
  /** The reporting currency every stored cost is in (see FinopsRepository.reportingCurrency). */
  async costCurrency(): Promise<string> {
    return config.COST_CURRENCY;
  }

  /** Sum of cost since `since`, grouped by subscription external id. */
  async costBySubscription(since: Date): Promise<Map<string, number>> {
    const rows = await this.prisma.costRecord.groupBy({
      by: ['subscriptionExternalId'],
      where: { date: { gte: since }, subscriptionExternalId: { not: null } },
      _sum: { cost: true },
    });
    return new Map(rows.map((r) => [r.subscriptionExternalId as string, r._sum.cost ?? 0]));
  }

  /** Sum of cost since `since`, grouped by (lowercased) resource-group external id. */
  async costByResourceGroup(since: Date): Promise<Map<string, number>> {
    const rows = await this.prisma.costRecord.groupBy({
      by: ['resourceGroupExternalId'],
      where: { date: { gte: since }, resourceGroupExternalId: { not: null } },
      _sum: { cost: true },
    });
    return new Map(rows.map((r) => [r.resourceGroupExternalId as string, r._sum.cost ?? 0]));
  }

  /** Sum of cost since `since` for the given resource db ids, grouped by resourceId. */
  async costByResourceId(since: Date, resourceIds: string[]): Promise<Map<string, number>> {
    if (resourceIds.length === 0) return new Map();
    const rows = await this.prisma.costRecord.groupBy({
      by: ['resourceId'],
      where: { date: { gte: since }, resourceId: { in: resourceIds } },
      _sum: { cost: true },
    });
    return new Map(rows.filter((r) => r.resourceId).map((r) => [r.resourceId as string, r._sum.cost ?? 0]));
  }

  /** Distinct facet values for filter dropdowns / multi-selects. */
  async facets() {
    const [types, locations, organizations, owners, lifecycleStages, subscriptions, tagKeyRows] = await Promise.all([
      this.prisma.resource.findMany({ distinct: ['type'], select: { type: true }, orderBy: { type: 'asc' } }),
      this.prisma.resource.findMany({
        distinct: ['location'],
        select: { location: true },
        where: { location: { not: null } },
        orderBy: { location: 'asc' },
      }),
      this.prisma.tenant.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.resource.findMany({
        distinct: ['owner'],
        select: { owner: true },
        where: { owner: { not: null } },
        orderBy: { owner: 'asc' },
      }),
      this.prisma.resource.findMany({
        distinct: ['lifecycleStage'],
        select: { lifecycleStage: true },
        orderBy: { lifecycleStage: 'asc' },
      }),
      this.prisma.subscription.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      // Distinct tag keys across all resources (for the tag filter picker).
      this.prisma.$queryRaw<{ k: string }[]>`
        SELECT DISTINCT k FROM "Resource", LATERAL jsonb_object_keys("tags") AS k ORDER BY k LIMIT 200
      `,
    ]);
    return {
      types: types.map((t) => t.type),
      locations: locations.map((l) => l.location).filter((l): l is string => Boolean(l)),
      organizations,
      owners: owners.map((o) => o.owner).filter((o): o is string => Boolean(o)),
      lifecycleStages: lifecycleStages.map((l) => l.lifecycleStage as string),
      subscriptions,
      tagKeys: tagKeyRows.map((r) => r.k),
    };
  }

  /**
   * Failing, non-exempt compliance checks per resource (enabled rules only),
   * with the worst severity — for the inventory's "Issues" column.
   */
  async issuesFor(resourceIds: string[]): Promise<Map<string, { failing: number; worst: string }>> {
    if (resourceIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ id: string; n: bigint; worst: number }[]>`
      SELECT c."scopeId" AS id, count(*) AS n,
             max(CASE r.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) AS worst
      FROM "ComplianceResult" c JOIN "StandardRule" r ON r.id = c."ruleId"
      WHERE c."scopeType" = 'resource' AND c."scopeId" = ANY(${resourceIds}::text[])
        AND NOT c.passed AND NOT c.exempt AND r.enabled
      GROUP BY c."scopeId"`;
    const name = ['low', 'low', 'medium', 'high'];
    return new Map(rows.map((r) => [r.id, { failing: Number(r.n), worst: name[r.worst] ?? 'low' }]));
  }

  /** Counts + 30-day cost of the filtered inventory, grouped. */
  async groups(q: ResourceQuery, groupBy: InventoryGroupBy) {
    const where = await this.whereFor(q);
    type Agg = { _count: { _all: number }; _sum: { costMonthly: number | null } };
    const agg = { _count: { _all: true }, _sum: { costMonthly: true } } as const;
    const n = (a: Agg) => ({ count: a._count._all, costMonthly: a._sum.costMonthly ?? 0 });

    if (groupBy === 'type' || groupBy === 'category') {
      const rows = await this.prisma.resource.groupBy({ by: ['type'], where, ...agg });
      return rows.map((r) => ({ key: r.type, ...n(r as Agg) }));
    }
    if (groupBy === 'location') {
      const rows = await this.prisma.resource.groupBy({ by: ['location'], where, ...agg });
      return rows.map((r) => ({ key: r.location ?? '', ...n(r as Agg) }));
    }
    if (groupBy === 'owner') {
      const rows = await this.prisma.resource.groupBy({ by: ['owner'], where, ...agg });
      return rows.map((r) => ({ key: r.owner ?? '', ...n(r as Agg) }));
    }
    if (groupBy === 'resourceGroup') {
      const rows = await this.prisma.resource.groupBy({ by: ['resourceGroupId'], where, ...agg });
      return rows.map((r) => ({ key: r.resourceGroupId ?? '', ...n(r as Agg) }));
    }
    const rows = await this.prisma.resource.groupBy({ by: ['subscriptionId'], where, ...agg });
    return rows.map((r) => ({ key: r.subscriptionId ?? '', ...n(r as Agg) }));
  }

  /** Names for group keys. */
  scopeNames() {
    return Promise.all([
      this.prisma.tenant.findMany({ select: { id: true, name: true } }),
      this.prisma.subscription.findMany({ select: { id: true, name: true, tenantId: true } }),
      this.prisma.resourceGroup.findMany({ select: { id: true, name: true, subscriptionId: true } }),
    ]);
  }

  /** Resource counts per subscription × resource group (for the scope tree). */
  countsByScope(states: string[]) {
    return this.prisma.resource.groupBy({
      by: ['subscriptionId', 'resourceGroupId'],
      where: { state: { in: states as $Enums.ResourceState[] } },
      _count: { _all: true },
    });
  }
}
