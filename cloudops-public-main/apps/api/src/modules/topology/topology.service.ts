import {
  TOPOLOGY_CATEGORIES,
  categoryForType,
  type TopologyCategory,
  type TopologyClusterDto,
  type TopologyClusterLinkDto,
  type TopologyClusterQuery,
  type TopologyClusterResult,
  type TopologyEdgeDto,
  type TopologyNeighborhoodQuery,
  type TopologyNodeDto,
  type TopologyQuery,
  type TopologyResult,
} from '@cloudops/core';
import { AppError } from '../../http/errors.js';
import type { TopologyNodeRow, TopologyRepository } from './topology.repository.js';

/** Default cap on in-scope nodes before the graph is flagged truncated. */
const DEFAULT_LIMIT = 400;
/** Focus mode stops expanding past this many nodes. */
const FOCUS_LIMIT = 300;

function toNode(r: TopologyNodeRow, external: boolean, issues?: { failing: number; worst: string }, hop?: number): TopologyNodeDto {
  return {
    id: r.id,
    externalId: r.externalId,
    name: r.name,
    type: r.type,
    category: categoryForType(r.type),
    subscriptionId: r.subscriptionId,
    resourceGroupId: r.resourceGroupId,
    owner: r.owner,
    costMonthly: r.costMonthly,
    location: r.location,
    failingChecks: issues?.failing ?? 0,
    worstSeverity: issues?.worst ?? null,
    external,
    ...(hop !== undefined ? { hop } : {}),
  };
}

function presentCategories(nodes: TopologyNodeDto[]): TopologyCategory[] {
  const present = new Set(nodes.map((n) => n.category));
  return TOPOLOGY_CATEGORIES.filter((c): c is TopologyCategory => present.has(c));
}

export class TopologyService {
  constructor(
    private readonly repo: TopologyRepository,
    private readonly currency = 'USD',
  ) {}

  /**
   * Build the dependency graph for a scope. Primary nodes are the resources
   * matching the filter (capped at `limit`); edges are their relationships. Any
   * connected resource outside the scope is pulled in as a dimmed "external"
   * neighbour so cross-scope dependencies stay visible.
   */
  async graph(q: TopologyQuery): Promise<TopologyResult> {
    const limit = q.limit ?? DEFAULT_LIMIT;
    const [total, primary, types] = await Promise.all([
      this.repo.countInScope(q),
      this.repo.primaryNodes(q, limit),
      this.repo.distinctTypesInScope(q),
    ]);

    const primaryIds = primary.map((n) => n.id);
    const primarySet = new Set(primaryIds);
    const rels = primaryIds.length ? await this.repo.relationshipsForNodes(primaryIds, q.relTypes) : [];

    // Neighbours = edge endpoints that are not themselves in scope.
    const neighborIds = new Set<string>();
    for (const r of rels) {
      if (!primarySet.has(r.sourceId)) neighborIds.add(r.sourceId);
      if (!primarySet.has(r.targetId)) neighborIds.add(r.targetId);
    }
    const neighbors = neighborIds.size ? await this.repo.nodesByIds([...neighborIds]) : [];
    const issues = await this.repo.issuesFor([...primaryIds, ...neighborIds]);

    const nodes: TopologyNodeDto[] = [
      ...primary.map((n) => toNode(n, false, issues.get(n.id))),
      ...neighbors.map((n) => toNode(n, true, issues.get(n.id))),
    ];
    const nodeSet = new Set(nodes.map((n) => n.id));

    // Drop any edge whose endpoint was filtered out (e.g. a deleted neighbour).
    const edges: TopologyEdgeDto[] = rels
      .filter((r) => nodeSet.has(r.sourceId) && nodeSet.has(r.targetId))
      .map((r) => ({ id: r.id, source: r.sourceId, target: r.targetId, type: r.type }));

    return {
      currency: this.currency,
      nodes,
      edges,
      categories: presentCategories(nodes),
      types,
      stats: {
        total,
        shown: primary.length,
        neighbors: neighbors.length,
        edges: edges.length,
        truncated: total > primary.length,
        limit,
      },
    };
  }

  /**
   * Focus mode: walk the relationship graph out from one resource, `depth`
   * hops, in one direction or both — what it depends on, what depends on it.
   * Server-side and bounded, so a hub in a huge estate stays renderable.
   */
  async neighborhood(id: string, q: TopologyNeighborhoodQuery): Promise<TopologyResult> {
    const [root] = await this.repo.nodesByIds([id]);
    if (!root) throw AppError.notFound('Resource not found');
    const hops = new Map<string, number>([[root.id, 0]]);
    const edgeMap = new Map<string, TopologyEdgeDto>();
    let frontier = [root.id];
    let truncated = false;

    for (let depth = 1; depth <= q.depth && frontier.length; depth++) {
      const found = await this.repo.edgesFrom(frontier, q.direction, q.relTypes);
      const next: string[] = [];
      for (const e of found) {
        const inFrontier = frontier.includes(e.sourceId) || frontier.includes(e.targetId);
        if (!inFrontier) continue;
        const others = [e.sourceId, e.targetId].filter((x) => !hops.has(x));
        let room = true;
        for (const o of others) {
          if (hops.size >= FOCUS_LIMIT) {
            truncated = true;
            room = false;
            break;
          }
          hops.set(o, depth);
          next.push(o);
        }
        if (room) edgeMap.set(e.id, { id: e.id, source: e.sourceId, target: e.targetId, type: e.type });
      }
      frontier = next;
    }

    const ids = [...hops.keys()];
    const [rows, issues] = await Promise.all([this.repo.nodesByIds(ids), this.repo.issuesFor(ids)]);
    const nodes = rows.map((r) => toNode(r, false, issues.get(r.id), hops.get(r.id)));
    const present = new Set(ids);
    const edges = [...edgeMap.values()].filter((e) => present.has(e.source) && present.has(e.target));
    return {
      currency: this.currency,
      nodes,
      edges,
      categories: presentCategories(nodes),
      types: [...new Set(nodes.map((n) => n.type))].sort(),
      stats: { total: nodes.length, shown: nodes.length, neighbors: nodes.length - 1, edges: edges.length, truncated, limit: FOCUS_LIMIT },
      focus: { id: root.id, depth: q.depth, direction: q.direction },
    };
  }

  /**
   * The map view: the scope aggregated into clusters (resource groups,
   * subscriptions, categories, types or regions) with edge counts between
   * them. Computed in SQL, so it stays a few dozen nodes however large the
   * estate is; click a cluster to drill into its resources.
   */
  async clusters(q: TopologyClusterQuery): Promise<TopologyClusterResult> {
    const [rows, links, failing] = await Promise.all([
      this.repo.clusterNodes(q, q.groupBy),
      this.repo.clusterLinks(q, q.groupBy),
      this.repo.failingByCluster(q, q.groupBy),
    ]);
    const keyOf = (raw: string | null) => (q.groupBy === 'category' ? categoryForType(raw) : (raw ?? ''));

    const agg = new Map<string, { resources: number; cost: number; cats: Map<TopologyCategory, number> }>();
    for (const r of rows) {
      const key = keyOf(r.key);
      const a = agg.get(key) ?? { resources: 0, cost: 0, cats: new Map() };
      a.resources += r.count;
      a.cost += r.cost;
      const cat = categoryForType(r.type);
      a.cats.set(cat, (a.cats.get(cat) ?? 0) + r.count);
      agg.set(key, a);
    }

    const linkMap = new Map<string, TopologyClusterLinkDto>();
    const externalKeys = new Set<string>();
    for (const l of links) {
      const a = keyOf(l.a);
      const b = keyOf(l.b);
      if (a === b) continue; // inside one cluster
      if (!agg.has(b)) externalKeys.add(b);
      const k = `${a}→${b}`;
      const link = linkMap.get(k) ?? { source: a, target: b, count: 0, types: {} };
      link.count += Number(l.n);
      link.types[l.type] = (link.types[l.type] ?? 0) + Number(l.n);
      linkMap.set(k, link);
    }

    const names = await this.repo.clusterNames(q.groupBy, [...agg.keys(), ...externalKeys].filter(Boolean));
    const label = (key: string) =>
      names.get(key)?.label ?? (key === '' ? (q.groupBy === 'location' ? 'no region' : 'none') : key.replace(/^microsoft\./i, ''));
    const clusters: TopologyClusterDto[] = [
      ...[...agg.entries()].map(([key, a]) => ({
        id: key,
        label: label(key),
        context: names.get(key)?.context ?? null,
        resources: a.resources,
        costMonthly: Math.round(a.cost * 100) / 100,
        category: [...a.cats.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? ('Other' as TopologyCategory),
        failing: failing.get(key) ?? 0,
        external: false,
      })),
      ...[...externalKeys].map((key) => ({
        id: key,
        label: label(key),
        context: names.get(key)?.context ?? null,
        resources: 0,
        costMonthly: 0,
        category: (q.groupBy === 'category' ? key : 'Other') as TopologyCategory,
        failing: 0,
        external: true,
      })),
    ].sort((a, b) => b.resources - a.resources);

    return {
      groupBy: q.groupBy,
      currency: this.currency,
      clusters,
      links: [...linkMap.values()],
      stats: { resources: [...agg.values()].reduce((n, a) => n + a.resources, 0), clusters: clusters.length, edges: [...linkMap.values()].reduce((n, l) => n + l.count, 0) },
    };
  }
}
