import { Prisma as PrismaNS } from '@prisma/client';
import { categoryForType, type TopologyClusterBy, type TopologyQuery } from '@cloudops/core';
import type { Prisma } from '../../infra/prisma.js';

/** Fields projected for every topology node. */
const NODE_SELECT = {
  id: true,
  externalId: true,
  name: true,
  type: true,
  owner: true,
  costMonthly: true,
  location: true,
  subscriptionId: true,
  resourceGroupId: true,
} satisfies PrismaNS.ResourceSelect;

export type TopologyNodeRow = PrismaNS.ResourceGetPayload<{ select: typeof NODE_SELECT }>;

/** Resource column a cluster groups on (whitelisted — used in raw SQL). */
const CLUSTER_COLUMN: Record<Exclude<TopologyClusterBy, 'category'>, string> = {
  resourceGroup: '"resourceGroupId"',
  subscription: '"subscriptionId"',
  type: 'type',
  location: 'location',
};

/** Data-access for the topology explorer: scoped resource nodes + their edges. */
export class TopologyRepository {
  constructor(private readonly prisma: Prisma) {}

  /** Category filter → the concrete types present in that category. */
  private async typesForCategory(category: string): Promise<string[]> {
    const all = await this.prisma.resource.findMany({ distinct: ['type'], select: { type: true } });
    const types = all.map((t) => t.type).filter((t) => categoryForType(t) === category);
    return types.length ? types : ['__none__'];
  }

  async buildWhere(q: TopologyQuery, opts?: { ignoreType?: boolean }): Promise<PrismaNS.ResourceWhereInput> {
    const where: PrismaNS.ResourceWhereInput = { state: 'active' };
    if (q.type && !opts?.ignoreType) where.type = q.type;
    else if (q.category && !opts?.ignoreType) where.type = { in: await this.typesForCategory(q.category) };
    if (q.location) where.location = q.location;
    // Organization filter: resources whose subscription belongs to this tenant/org.
    if (q.tenantId) where.subscription = { tenantId: q.tenantId };
    if (q.subscriptionId) where.subscriptionId = q.subscriptionId;
    if (q.resourceGroupId) where.resourceGroupId = q.resourceGroupId;
    return where;
  }

  async countInScope(q: TopologyQuery): Promise<number> {
    return this.prisma.resource.count({ where: await this.buildWhere(q) });
  }

  /**
   * Distinct resource types present in the scope, ignoring the `type` filter so
   * the topology type dropdown lists every in-scope type (never just the selected
   * one). Returns the raw Azure types, sorted.
   */
  async distinctTypesInScope(q: TopologyQuery): Promise<string[]> {
    const rows = await this.prisma.resource.groupBy({
      by: ['type'],
      where: await this.buildWhere(q, { ignoreType: true }),
      orderBy: { type: 'asc' },
    });
    return rows.map((r) => r.type);
  }

  async primaryNodes(q: TopologyQuery, take: number): Promise<TopologyNodeRow[]> {
    return this.prisma.resource.findMany({
      where: await this.buildWhere(q),
      select: NODE_SELECT,
      orderBy: { name: 'asc' },
      take,
    });
  }

  /** Every edge touching one of the given node ids (in either direction), optionally of some types. */
  relationshipsForNodes(ids: string[], relTypes?: string[]) {
    return this.prisma.resourceRelationship.findMany({
      where: {
        OR: [{ sourceId: { in: ids } }, { targetId: { in: ids } }],
        ...(relTypes?.length ? { type: { in: relTypes } } : {}),
      },
      select: { id: true, type: true, sourceId: true, targetId: true },
    });
  }

  /** Edges leaving (out) or entering (in) a set of nodes — one hop of a neighbourhood walk. */
  edgesFrom(ids: string[], direction: 'out' | 'in' | 'both', relTypes?: string[]) {
    const or: PrismaNS.ResourceRelationshipWhereInput[] = [];
    if (direction !== 'in') or.push({ sourceId: { in: ids } });
    if (direction !== 'out') or.push({ targetId: { in: ids } });
    return this.prisma.resourceRelationship.findMany({
      where: { OR: or, ...(relTypes?.length ? { type: { in: relTypes } } : {}), source: { state: 'active' }, target: { state: 'active' } },
      select: { id: true, type: true, sourceId: true, targetId: true },
      take: 5000,
    });
  }

  nodesByIds(ids: string[]): Promise<TopologyNodeRow[]> {
    return this.prisma.resource.findMany({ where: { id: { in: ids } }, select: NODE_SELECT });
  }

  /** Failing, non-exempt checks per resource with the worst severity (risk colouring). */
  async issuesFor(ids: string[]): Promise<Map<string, { failing: number; worst: string }>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ id: string; n: bigint; worst: number }[]>`
      SELECT c."scopeId" AS id, count(*) AS n,
             max(CASE r.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) AS worst
      FROM "ComplianceResult" c JOIN "StandardRule" r ON r.id = c."ruleId"
      WHERE c."scopeType" = 'resource' AND c."scopeId" = ANY(${ids}::text[]) AND NOT c.passed AND NOT c.exempt AND r.enabled
      GROUP BY c."scopeId"`;
    const name = ['low', 'low', 'medium', 'high'];
    return new Map(rows.map((r) => [r.id, { failing: Number(r.n), worst: name[r.worst] ?? 'low' }]));
  }

  // ── Cluster (map) view ────────────────────────────────────────────

  /** Resource count, cost, failing count and type mix per cluster key, for the scope. */
  async clusterNodes(q: TopologyQuery, groupBy: TopologyClusterBy) {
    const where = await this.buildWhere(q);
    const column = groupBy === 'category' ? 'type' : groupBy === 'resourceGroup' ? 'resourceGroupId' : groupBy === 'subscription' ? 'subscriptionId' : groupBy;
    const rows = await this.prisma.resource.groupBy({
      by: [column as 'type', 'type'],
      where,
      _count: { _all: true },
      _sum: { costMonthly: true },
    });
    return rows.map((r) => ({
      key: String((r as Record<string, unknown>)[column] ?? ''),
      type: r.type,
      count: r._count._all,
      cost: r._sum.costMonthly ?? 0,
    }));
  }

  /** SQL scope conditions on a resource alias (the same scope as buildWhere, minus category). */
  private scopeSql(alias: string, q: TopologyQuery): PrismaNS.Sql[] {
    const a = PrismaNS.raw(alias);
    const conds: PrismaNS.Sql[] = [PrismaNS.sql`${a}.state = 'active'`];
    if (q.tenantId) conds.push(PrismaNS.sql`${a}."subscriptionId" IN (SELECT id FROM "Subscription" WHERE "tenantId" = ${q.tenantId})`);
    if (q.subscriptionId) conds.push(PrismaNS.sql`${a}."subscriptionId" = ${q.subscriptionId}`);
    if (q.resourceGroupId) conds.push(PrismaNS.sql`${a}."resourceGroupId" = ${q.resourceGroupId}`);
    if (q.type) conds.push(PrismaNS.sql`${a}.type = ${q.type}`);
    if (q.location) conds.push(PrismaNS.sql`${a}.location = ${q.location}`);
    return conds;
  }

  /** Resources with high-severity failing checks, per cluster key — one indexed query. */
  async failingByCluster(q: TopologyQuery, groupBy: TopologyClusterBy): Promise<Map<string, number>> {
    const col = PrismaNS.raw(CLUSTER_COLUMN[groupBy === 'category' ? 'type' : groupBy]);
    const rows = await this.prisma.$queryRaw<{ k: string | null; n: bigint }[]>`
      SELECT r.${col} AS k, count(*) AS n FROM "Resource" r
      WHERE ${PrismaNS.join(this.scopeSql('r', q), ' AND ')}
        AND EXISTS (
          SELECT 1 FROM "ComplianceResult" c JOIN "StandardRule" sr ON sr.id = c."ruleId"
          WHERE c."scopeType" = 'resource' AND c."scopeId" = r.id AND NOT c.passed AND NOT c.exempt AND sr.enabled AND sr.severity = 'high')
      GROUP BY 1`;
    const out = new Map<string, number>();
    for (const r of rows) {
      const key = groupBy === 'category' ? categoryForType(r.k) : (r.k ?? '');
      out.set(key, (out.get(key) ?? 0) + Number(r.n));
    }
    return out;
  }

  /**
   * Edges between clusters, counted per relationship type. The source end is
   * in scope; the target end may be outside it (a cross-scope dependency).
   */
  async clusterLinks(q: TopologyQuery, groupBy: TopologyClusterBy) {
    const col = PrismaNS.raw(CLUSTER_COLUMN[groupBy === 'category' ? 'type' : groupBy]);
    const conds: PrismaNS.Sql[] = [...this.scopeSql('s', q), PrismaNS.sql`t.state = 'active'`];
    if (q.relTypes?.length) conds.push(PrismaNS.sql`rel.type = ANY(${q.relTypes}::text[])`);
    return this.prisma.$queryRaw<{ a: string | null; b: string | null; type: string; n: bigint }[]>`
      SELECT s.${col} AS a, t.${col} AS b, rel.type, count(*) AS n
      FROM "ResourceRelationship" rel
      JOIN "Resource" s ON s.id = rel."sourceId"
      JOIN "Resource" t ON t.id = rel."targetId"
      WHERE ${PrismaNS.join(conds, ' AND ')}
      GROUP BY 1, 2, 3`;
  }

  /** Display names for resource-group / subscription cluster keys. */
  async clusterNames(groupBy: TopologyClusterBy, keys: string[]) {
    if (groupBy === 'resourceGroup') {
      const rows = await this.prisma.resourceGroup.findMany({
        where: { id: { in: keys } },
        select: { id: true, name: true, subscription: { select: { name: true } } },
      });
      return new Map(rows.map((r) => [r.id, { label: r.name, context: r.subscription.name }]));
    }
    if (groupBy === 'subscription') {
      const rows = await this.prisma.subscription.findMany({
        where: { id: { in: keys } },
        select: { id: true, name: true, tenant: { select: { name: true } } },
      });
      return new Map(rows.map((r) => [r.id, { label: r.name, context: r.tenant?.name ?? null }]));
    }
    return new Map<string, { label: string; context: string | null }>();
  }
}
