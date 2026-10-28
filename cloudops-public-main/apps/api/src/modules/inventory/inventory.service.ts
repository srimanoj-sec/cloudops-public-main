import {
  categoryForType,
  paginate,
  type InventoryGroupBy,
  type InventoryGroupDto,
  type InventoryGroupsDto,
  type InventoryTreeDto,
  type FacetsDto,
  type OrganizationDto,
  type Paginated,
  type ResourceDetailDto,
  type ResourceDto,
  type ResourceGroupDto,
  type ResourceHistoryDto,
  type ResourceQuery,
  type ResourceActivityDto,
  type SubscriptionDto,
} from '@cloudops/core';
import { AppError } from '../../http/errors.js';
import { UNASSIGNED_OWNER, type InventoryRepository } from './inventory.repository.js';

type ResourceRow = {
  id: string;
  externalId: string;
  name: string;
  type: string;
  providerKey: string;
  location: string | null;
  sku: string | null;
  state: 'active' | 'deleted';
  lifecycleStage: string | null;
  tags: unknown;
  platformTags?: unknown;
  taggableInAzure?: boolean | null;
  properties?: unknown;
  owner: string | null;
  azureCreatedAt: Date | null;
  retireBy: Date | null;
  inUse: boolean | null;
  costDaily: number | null;
  costMonthly: number | null;
  subscriptionId: string | null;
  resourceGroupId: string | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  subscription?: { name: string; tenant?: { id: string; name: string } | null } | null;
  resourceGroup?: { name: string } | null;
};

function toResourceDto(r: ResourceRow): ResourceDto {
  return {
    organizationId: r.subscription?.tenant?.id ?? null,
    organizationName: r.subscription?.tenant?.name ?? null,
    subscriptionName: r.subscription?.name ?? null,
    resourceGroupName: r.resourceGroup?.name ?? null,
    category: categoryForType(r.type),
    id: r.id,
    externalId: r.externalId,
    name: r.name,
    type: r.type,
    providerKey: r.providerKey,
    location: r.location,
    sku: r.sku,
    state: r.state,
    lifecycleStage: r.lifecycleStage,
    tags: (r.tags as Record<string, string>) ?? {},
    platformTags: (r.platformTags as Record<string, string>) ?? null,
    taggableInAzure: r.taggableInAzure ?? null,
    owner: r.owner,
    azureCreatedAt: r.azureCreatedAt?.toISOString() ?? null,
    retireBy: r.retireBy?.toISOString() ?? null,
    inUse: r.inUse,
    costDaily: r.costDaily,
    costMonthly: r.costMonthly,
    subscriptionId: r.subscriptionId,
    resourceGroupId: r.resourceGroupId,
    lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Milliseconds in the 7-day daily-cost window. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/** Round a currency figure to 2 decimals. */
const money2 = (n: number): number => Math.round(n * 100) / 100;

/** Filter facets change only on sync; recomputing them per page view is wasted work. */
const FACETS_TTL_MS = 60_000;

/** CSV columns for the inventory export (header → value). */
type ExportRow = ResourceRow & { subscription: { name: string } | null; resourceGroup: { name: string } | null };
const EXPORT_COLUMNS: [string, (r: ExportRow, dailyCost: number | null) => unknown][] = [
  ['name', (r) => r.name],
  ['type', (r) => r.type],
  ['location', (r) => r.location],
  ['subscription', (r) => r.subscription?.name],
  ['resourceGroup', (r) => r.resourceGroup?.name],
  ['owner', (r) => r.owner],
  ['state', (r) => r.state],
  ['lifecycleStage', (r) => r.lifecycleStage],
  ['dailyCost7dAvg', (_r, cost) => cost],
  ['monthlyCost30d', (r) => (r.costMonthly != null ? money2(r.costMonthly) : null)],
  ['createdInProvider', (r) => r.azureCreatedAt?.toISOString()],
  ['lastSyncedAt', (r) => r.lastSyncedAt?.toISOString()],
  ['tags', (r) => (r.tags && Object.keys(r.tags as object).length ? JSON.stringify(r.tags) : '')],
  ['resourceId', (r) => r.externalId],
];

/**
 * One CSV cell. Quotes when needed, and neutralises spreadsheet formula
 * injection: resource names and tag values come from the cloud provider, so a
 * value like `=HYPERLINK(...)` must never execute when the file is opened.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class InventoryService {
  private facetsCache?: { expires: number; value: Promise<FacetsDto> };

  constructor(private readonly repo: InventoryRepository) {}

  /** Stream matching resources as CSV lines (header first). */
  async *exportCsv(q: ResourceQuery): AsyncGenerator<string> {
    yield `${EXPORT_COLUMNS.map(([h]) => h).join(',')}\r\n`;
    const since = new Date(Date.now() - SEVEN_DAYS_MS);
    for await (const batch of this.repo.iterateResources(q)) {
      const costs = await this.repo.costByResourceId(since, batch.map((r) => r.id));
      let chunk = '';
      for (const r of batch as unknown as ExportRow[]) {
        const sum = costs.get(r.id);
        const daily = sum != null ? money2(sum / 7) : null;
        chunk += `${EXPORT_COLUMNS.map(([, get]) => csvCell(get(r, daily))).join(',')}\r\n`;
      }
      yield chunk;
    }
  }

  async listResources(q: ResourceQuery): Promise<Paginated<ResourceDto>> {
    const { items, total } = await this.repo.listResources(q);
    const dtos = items.map((i) => toResourceDto(i as ResourceRow));

    // Attach the 7-day average daily cost for the page's resources.
    const since = new Date(Date.now() - SEVEN_DAYS_MS);
    const ids = dtos.map((d) => d.id);
    const [costMap, currency, issues] = await Promise.all([
      this.repo.costByResourceId(since, ids),
      this.repo.costCurrency(),
      this.repo.issuesFor(ids),
    ]);
    for (const d of dtos) {
      const sum = costMap.get(d.id);
      d.dailyCost = sum != null ? money2(sum / 7) : null;
      d.costCurrency = currency;
      const i = issues.get(d.id);
      d.failingChecks = i?.failing ?? 0;
      d.worstSeverity = i?.worst ?? null;
    }
    return paginate(dtos, total, q.page, q.pageSize);
  }

  /** The filtered inventory, grouped — each group carries the filter that selects it. */
  async groups(q: ResourceQuery, groupBy: InventoryGroupBy): Promise<InventoryGroupsDto> {
    const [rows, [tenants, subs, rgs], currency] = await Promise.all([
      this.repo.groups(q, groupBy === 'organization' ? 'subscription' : groupBy),
      this.repo.scopeNames(),
      this.repo.costCurrency(),
    ]);
    const tenantName = new Map(tenants.map((t) => [t.id, t.name]));
    const sub = new Map(subs.map((s) => [s.id, s]));
    const rg = new Map(rgs.map((r) => [r.id, r]));
    const merged = new Map<string, InventoryGroupDto>();
    const add = (key: string, label: string, context: string | null, filter: Record<string, string>, count: number, cost: number) => {
      const g = merged.get(key) ?? { key, label, context, count: 0, costMonthly: 0, filter };
      g.count += count;
      g.costMonthly = money2(g.costMonthly + cost);
      merged.set(key, g);
    };

    for (const r of rows) {
      switch (groupBy) {
        case 'category': {
          const c = categoryForType(r.key);
          add(c, c, null, { categories: c }, r.count, r.costMonthly);
          break;
        }
        case 'type':
          add(r.key, r.key, categoryForType(r.key), { types: r.key }, r.count, r.costMonthly);
          break;
        case 'location':
          add(r.key || '—', r.key || 'No region', null, r.key ? { locations: r.key } : {}, r.count, r.costMonthly);
          break;
        case 'owner':
          add(r.key || '—', r.key || 'Unassigned', null, { owners: r.key || UNASSIGNED_OWNER }, r.count, r.costMonthly);
          break;
        case 'resourceGroup': {
          const g = rg.get(r.key);
          const s = g ? sub.get(g.subscriptionId) : undefined;
          const ctx = [s?.tenantId ? tenantName.get(s.tenantId) : null, s?.name].filter(Boolean).join(' › ') || null;
          add(r.key || '—', g?.name ?? 'No resource group', ctx, r.key ? { resourceGroupId: r.key } : {}, r.count, r.costMonthly);
          break;
        }
        case 'subscription': {
          const s = sub.get(r.key);
          add(r.key || '—', s?.name ?? 'No subscription', s?.tenantId ? (tenantName.get(s.tenantId) ?? null) : null, r.key ? { subscriptionIds: r.key } : {}, r.count, r.costMonthly);
          break;
        }
        case 'organization': {
          const t = sub.get(r.key)?.tenantId ?? '';
          add(t || '—', t ? (tenantName.get(t) ?? 'Organization') : 'No organization', null, t ? { tenantId: t } : {}, r.count, r.costMonthly);
          break;
        }
      }
    }
    const groups = [...merged.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return { groupBy, total: groups.reduce((n, g) => n + g.count, 0), groups: groups.slice(0, 500), costCurrency: currency };
  }

  /** Org › subscription › resource group with resource counts (the scope navigator). */
  async tree(states: string[]): Promise<InventoryTreeDto> {
    const [counts, [tenants, subs, rgs]] = await Promise.all([this.repo.countsByScope(states), this.repo.scopeNames()]);
    const bySub = new Map<string, number>();
    const byRg = new Map<string, number>();
    for (const c of counts) {
      if (c.subscriptionId) bySub.set(c.subscriptionId, (bySub.get(c.subscriptionId) ?? 0) + c._count._all);
      if (c.resourceGroupId) byRg.set(c.resourceGroupId, (byRg.get(c.resourceGroupId) ?? 0) + c._count._all);
    }
    const rgsBySub = new Map<string, { id: string; name: string; count: number }[]>();
    for (const g of rgs) {
      const n = byRg.get(g.id) ?? 0;
      if (n === 0) continue;
      rgsBySub.set(g.subscriptionId, [...(rgsBySub.get(g.subscriptionId) ?? []), { id: g.id, name: g.name, count: n }]);
    }
    const orgs = new Map<string, InventoryTreeDto['organizations'][number]>();
    for (const s of subs) {
      const key = s.tenantId ?? '';
      const org = orgs.get(key) ?? {
        id: s.tenantId,
        name: s.tenantId ? (tenants.find((t) => t.id === s.tenantId)?.name ?? 'Organization') : 'Unassigned',
        count: 0,
        subscriptions: [],
      };
      const count = bySub.get(s.id) ?? 0;
      org.count += count;
      org.subscriptions.push({
        id: s.id,
        name: s.name,
        count,
        resourceGroups: (rgsBySub.get(s.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      });
      orgs.set(key, org);
    }
    const organizations = [...orgs.values()]
      .map((o) => ({ ...o, subscriptions: o.subscriptions.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { organizations };
  }

  async getResource(id: string): Promise<ResourceDetailDto> {
    const r = await this.repo.getResource(id);
    if (!r) throw AppError.notFound('Resource not found');
    const base = toResourceDto(r as unknown as ResourceRow);
    const [costs, currency] = await Promise.all([
      this.repo.costByResourceId(new Date(Date.now() - SEVEN_DAYS_MS), [r.id]),
      this.repo.costCurrency(),
    ]);
    const week = costs.get(r.id);
    const tenant = r.subscription?.tenant?.externalId;
    return {
      ...base,
      dailyCost: week != null ? money2(week / 7) : null,
      costCurrency: currency,
      properties: (r.properties as Record<string, unknown>) ?? {},
      relationships: r.relationshipsFrom.map((rel) => ({
        id: rel.id,
        type: rel.type,
        targetResourceId: rel.targetId,
        targetName: rel.target?.name,
      })),
      dependents: r.relationshipsTo.map((rel) => ({
        id: rel.id,
        type: rel.type,
        sourceResourceId: rel.sourceId,
        sourceName: rel.source?.name,
      })),
      portalUrl:
        r.providerKey === 'azure' ? `https://portal.azure.com/#${tenant ? `@${tenant}` : ''}/resource${r.externalId}` : null,
    };
  }

  /** The resource's activity timeline, newest first. */
  async activity(id: string): Promise<ResourceActivityDto[]> {
    const r = await this.repo.getResource(id);
    if (!r) throw AppError.notFound('Resource not found');
    const a = await this.repo.activityFor(r.id);
    const short = (v: unknown) => {
      const s = v == null ? '—' : typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 80 ? `${s.slice(0, 77)}…` : s;
    };
    const out: ResourceActivityDto[] = [
      ...a.changes.map((c) => ({
        id: `c:${c.id}`,
        at: c.detectedAt.toISOString(),
        kind: 'change' as const,
        title: `${c.field} changed`,
        detail: `${short(c.oldValue)} → ${short(c.newValue)}`,
        actor: 'sync',
        link: c.syncRunId ? `/operations/syncs?run=${c.syncRunId}` : null,
      })),
      ...a.lifecycle.map((l) => ({
        id: `l:${l.id}`,
        at: l.createdAt.toISOString(),
        kind: 'lifecycle' as const,
        title: l.stage,
        detail: l.reason,
        actor: l.actor,
        link: null,
      })),
      ...a.audits.map((e) => {
        const m = (e.metadata ?? {}) as Record<string, unknown>;
        const title =
          e.action === 'resource.tags.write'
            ? 'Tags written to the cloud'
            : e.action === 'resource.tags.platform-only'
              ? 'Tags stored in CloudOps (type can’t be tagged)'
              : e.action === 'resource.refresh'
                ? 'Refreshed from the provider'
                : e.action === 'resource.evaluate'
                  ? 'Compliance re-evaluated'
                  : e.action;
        const upserts = m.upserts as Record<string, string> | undefined;
        const removes = m.removes as string[] | undefined;
        const detail = upserts || removes
          ? [
              ...Object.entries(upserts ?? {}).map(([k, v]) => `${k}=${v}`),
              ...(removes ?? []).map((k) => `−${k}`),
            ].join(', ')
          : Array.isArray(m.changed) ? (m.changed as string[]).join(', ') || 'no changes' : null;
        return { id: `a:${e.id}`, at: e.createdAt.toISOString(), kind: 'audit' as const, title, detail, actor: e.actor, link: null };
      }),
      ...a.targets.map((t) => ({
        id: `r:${t.id}`,
        at: (t.finishedAt ?? t.run.createdAt).toISOString(),
        kind: 'remediation' as const,
        title: `Remediation: ${t.run.title}`,
        detail: `${t.status.replace('_', ' ')}${t.message ? ` — ${t.message}` : ''}`,
        actor: t.run.executedBy ?? t.run.requestedBy,
        link: `/remediation/${t.run.id}`,
      })),
      ...a.links.map((l) => ({
        id: `w:${l.id}`,
        at: l.workItem.createdAt.toISOString(),
        kind: 'work' as const,
        title: `Work item: ${l.workItem.title}`,
        detail: `${l.workItem.type} · ${l.workItem.state.replace('_', ' ')}`,
        actor: l.workItem.createdBy,
        link: `/work/${l.workItem.id}`,
      })),
      ...a.exemptions.map((x) => ({
        id: `x:${x.id}`,
        at: x.createdAt.toISOString(),
        kind: 'exemption' as const,
        title: `Exempted from “${x.rule.name ?? x.rule.description}”`,
        detail: `${x.reason}${x.expiresAt ? ` · until ${x.expiresAt.toISOString().slice(0, 10)}` : ' · no end date'}`,
        actor: x.createdBy,
        link: '/standards?tab=exemptions',
      })),
    ];
    return out.sort((x, y) => y.at.localeCompare(x.at)).slice(0, 200);
  }

  async listSubscriptions(tenantId?: string): Promise<SubscriptionDto[]> {
    const since = new Date(Date.now() - SEVEN_DAYS_MS);
    const [subs, costMap, currency] = await Promise.all([
      this.repo.listSubscriptions(tenantId),
      this.repo.costBySubscription(since),
      this.repo.costCurrency(),
    ]);
    return subs.map((s) => {
      const sum = costMap.get(s.externalId);
      return {
        id: s.id,
        externalId: s.externalId,
        name: s.name,
        tenantId: s.tenantId,
        organizationName: s.tenant?.name ?? null,
        state: s.state,
        resourceGroupCount: s._count.resourceGroups,
        resourceCount: s._count.resources,
        dailyCost: sum != null ? money2(sum / 7) : null,
        costCurrency: currency,
      };
    });
  }

  async listOrganizations(tenantId?: string): Promise<OrganizationDto[]> {
    const tenants = await this.repo.listOrganizations(tenantId);
    return tenants.map((t) => {
      const resourceGroupCount = t.subscriptions.reduce((n, s) => n + s._count.resourceGroups, 0);
      const resourceCount = t.subscriptions.reduce((n, s) => n + s._count.resources, 0);
      const lastSyncedAt = t.subscriptions
        .map((s) => s.lastSyncedAt)
        .filter((d): d is Date => d != null)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        id: t.id,
        externalId: t.externalId,
        name: t.name,
        providerKey: t.providerKey,
        subscriptionCount: t.subscriptions.length,
        resourceGroupCount,
        resourceCount,
        lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
      };
    });
  }

  async listResourceGroups(subscriptionId?: string, tenantId?: string): Promise<ResourceGroupDto[]> {
    const since = new Date(Date.now() - SEVEN_DAYS_MS);
    const [rgs, costMap, currency] = await Promise.all([
      this.repo.listResourceGroups(subscriptionId, tenantId),
      this.repo.costByResourceGroup(since),
      this.repo.costCurrency(),
    ]);
    return rgs.map((rg) => {
      // CostRecord RG ids are lowercased; RG.externalId is stored lowercased too.
      const sum = costMap.get(rg.externalId.toLowerCase());
      return {
        id: rg.id,
        externalId: rg.externalId,
        name: rg.name,
        location: rg.location,
        subscriptionId: rg.subscriptionId,
        subscriptionName: rg.subscription?.name ?? null,
        resourceCount: rg._count.resources,
        tags: (rg.tags as Record<string, string>) ?? {},
        dailyCost: sum != null ? money2(sum / 7) : null,
        costCurrency: currency,
      };
    });
  }

  async getResourceHistory(id: string): Promise<ResourceHistoryDto> {
    const history = await this.repo.getResourceHistory(id);
    if (!history) throw AppError.notFound('Resource not found');
    return {
      lifecycleEvents: history.lifecycleEvents.map((e) => ({
        id: e.id,
        stage: e.stage,
        actor: e.actor,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
      })),
      changeEvents: history.changeEvents.map((c) => ({
        id: c.id,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        syncRunId: c.syncRunId,
        detectedAt: c.detectedAt.toISOString(),
      })),
    };
  }

  facets(): Promise<FacetsDto> {
    const now = Date.now();
    if (!this.facetsCache || this.facetsCache.expires < now) {
      const value = this.repo.facets();
      this.facetsCache = { expires: now + FACETS_TTL_MS, value };
      value.catch(() => {
        this.facetsCache = undefined; // never cache a failure
      });
    }
    return this.facetsCache.value;
  }
}
