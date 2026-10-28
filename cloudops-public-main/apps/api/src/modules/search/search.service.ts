import type { Prisma as PrismaNS } from '@prisma/client';
import {
  SEARCH_KINDS,
  SEARCH_KIND_LABELS,
  categoryForType,
  formatMoney,
  type SearchGroupDto,
  type SearchKind,
  type SearchQuery,
  type SearchResponseDto,
  type SearchResultDto,
} from '@cloudops/core';
import { config } from '../../env.js';
import type { Prisma } from '../../infra/prisma.js';

/** Who is searching — decides which kinds they may see. */
export interface Searcher {
  permissions: string[];
}

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const TAG = /^([^\s:=/]{1,100})[:=](.{1,200})$/;
const CUID = /^c[a-z0-9]{20,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NETWORK_TYPES = [
  'microsoft.network/publicipaddresses',
  'microsoft.network/networkinterfaces',
  'microsoft.network/loadbalancers',
  'microsoft.network/applicationgateways',
  'microsoft.network/azurefirewalls',
  'microsoft.network/privateendpoints',
];

const shortType = (t: string) => t.replace(/^microsoft\./i, '');
const ci = (value: string) => ({ contains: value, mode: 'insensitive' as const });

/** 0 exact · 1 prefix · 2 word-prefix · 3 contains · 4 matched elsewhere. */
function rank(title: string, q: string): number {
  const t = title.toLowerCase();
  const s = q.toLowerCase();
  if (t === s) return 0;
  if (t.startsWith(s)) return 1;
  if (new RegExp(`[\\s._/-]${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return 2;
  if (t.includes(s)) return 3;
  return 4;
}

function ranked<T extends { title: string }>(items: T[], q: string, limit: number): { items: T[]; more: boolean } {
  const sorted = [...items].sort((a, b) => rank(a.title, q) - rank(b.title, q) || a.title.localeCompare(b.title));
  return { items: sorted.slice(0, limit), more: sorted.length > limit };
}

/**
 * Global search across the estate (organizations → resources), the work and
 * knowledge the platform holds, and — for callers allowed to see them — users
 * and audit events. Each kind is one bounded, index-backed query (trigram GIN
 * indexes on the searched text columns), run in parallel.
 */
export class SearchService {
  constructor(private readonly prisma: Prisma) {}

  private allowed(kind: SearchKind, who: Searcher): boolean {
    if (kind === 'user') return who.permissions.includes('users.manage');
    if (kind === 'audit') return who.permissions.includes('audit.read');
    return true;
  }

  async search(q: SearchQuery, who: Searcher): Promise<SearchResponseDto> {
    const started = Date.now();
    const kinds = (q.kinds?.length ? q.kinds : [...SEARCH_KINDS]).filter((k) => this.allowed(k, who));
    const take = q.limit * 3;
    const text = q.q;

    const runners: Record<SearchKind, () => Promise<{ items: SearchResultDto[]; more: boolean }>> = {
      resource: () => this.resources(text, take, q.limit, q.tenantId),
      resourceGroup: () => this.resourceGroups(text, take, q.limit, q.tenantId),
      subscription: () => this.subscriptions(text, take, q.limit, q.tenantId),
      organization: () => this.organizations(text, take, q.limit, q.tenantId),
      workItem: () => this.workItems(text, take, q.limit),
      rule: () => this.rules(text, take, q.limit),
      document: () => this.documents(text, take, q.limit),
      remediation: () => this.remediations(text, take, q.limit),
      syncRun: () => this.syncRuns(text),
      user: () => this.users(text, take, q.limit),
      audit: () => this.audit(text, q.limit),
    };

    const results = await Promise.all(kinds.map(async (kind) => ({ kind, ...(await runners[kind]()) })));
    const groups: SearchGroupDto[] = results
      .filter((r) => r.items.length > 0)
      .map((r) => ({ kind: r.kind, label: SEARCH_KIND_LABELS[r.kind], items: r.items, more: r.more }));
    return { query: text, groups, tookMs: Date.now() - started };
  }

  // ── Estate ─────────────────────────────────────────────────────────

  private async resources(text: string, take: number, limit: number, tenantId?: string) {
    const scope: PrismaNS.ResourceWhereInput = tenantId ? { subscription: { tenantId } } : {};
    const matchedBy = new Map<string, string>();
    const extraIds: string[] = [];

    // `key=value` / `key:value` → tag match (case-insensitive key, value prefix).
    const tag = TAG.exec(text);
    if (tag && !text.includes('://')) {
      const [, key, value] = tag;
      const rows = await this.prisma.$queryRaw<{ id: string; k: string; v: string }[]>`
        SELECT r.id, t.key AS k, t.value AS v FROM "Resource" r, jsonb_each_text(r.tags) t
        WHERE lower(t.key) = lower(${key}) AND t.value ILIKE ${`${value}%`}
        LIMIT ${take}`;
      for (const r of rows) {
        extraIds.push(r.id);
        matchedBy.set(r.id, `tag ${r.k}=${r.v}`);
      }
    }
    // IPv4 → network resources whose configuration mentions it.
    if (IPV4.test(text)) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Resource"
        WHERE lower(type) = ANY(${NETWORK_TYPES}::text[]) AND properties::text LIKE ${`%"${text}"%`}
        LIMIT ${take}`;
      for (const r of rows) {
        extraIds.push(r.id);
        matchedBy.set(r.id, `IP ${text}`);
      }
    }

    const rows = await this.prisma.resource.findMany({
      where: {
        AND: [
          scope,
          {
            OR: [
              { name: ci(text) },
              { externalId: ci(text) },
              { owner: ci(text) },
              ...(extraIds.length ? [{ id: { in: extraIds } }] : []),
            ],
          },
        ],
      },
      select: {
        id: true,
        name: true,
        type: true,
        location: true,
        state: true,
        owner: true,
        externalId: true,
        costMonthly: true,
        lifecycleStage: true,
        subscription: { select: { name: true, tenant: { select: { name: true } } } },
        resourceGroup: { select: { name: true } },
      },
      orderBy: [{ state: 'asc' }, { name: 'asc' }],
      take,
    });

    const lower = text.toLowerCase();
    const items: SearchResultDto[] = rows.map((r) => {
      const where = [r.subscription?.tenant?.name, r.subscription?.name, r.resourceGroup?.name].filter(Boolean).join(' › ');
      const matched =
        matchedBy.get(r.id) ??
        (r.name.toLowerCase().includes(lower)
          ? null
          : r.externalId.toLowerCase().includes(lower)
            ? 'resource id'
            : r.owner?.toLowerCase().includes(lower)
              ? `owner ${r.owner}`
              : null);
      return {
        kind: 'resource',
        id: r.id,
        title: r.name,
        subtitle: `${shortType(r.type)}${r.location ? ` · ${r.location}` : ''}`,
        link: `/inventory/${r.id}`,
        matched,
        facts: [
          { label: 'Where', value: where || '—' },
          { label: 'Category', value: categoryForType(r.type) },
          { label: 'Owner', value: r.owner ?? 'unassigned' },
          { label: 'Monthly cost', value: r.costMonthly != null ? formatMoney(r.costMonthly, config.COST_CURRENCY, { compact: true }) : '—' },
          { label: 'Lifecycle', value: r.lifecycleStage },
        ],
        badge: r.state === 'deleted' ? { label: 'deleted', tone: 'danger' } : null,
      };
    });
    // Tag / IP / id matches rank by relevance of the title only when the title matched.
    return ranked(items, text, limit);
  }

  private async resourceGroups(text: string, take: number, limit: number, tenantId?: string) {
    const rows = await this.prisma.resourceGroup.findMany({
      where: { name: ci(text), ...(tenantId ? { subscription: { tenantId } } : {}) },
      select: {
        id: true,
        name: true,
        location: true,
        subscription: { select: { id: true, name: true, tenant: { select: { name: true } } } },
        _count: { select: { resources: { where: { state: 'active' } } } },
      },
      take,
    });
    return ranked(
      rows.map(
        (r): SearchResultDto => ({
          kind: 'resourceGroup',
          id: r.id,
          title: r.name,
          subtitle: [r.subscription.tenant?.name, r.subscription.name].filter(Boolean).join(' › '),
          link: `/inventory?resourceGroupId=${r.id}`,
          matched: null,
          facts: [
            { label: 'Resources', value: String(r._count.resources) },
            { label: 'Location', value: r.location ?? '—' },
          ],
          badge: null,
        }),
      ),
      text,
      limit,
    );
  }

  private async subscriptions(text: string, take: number, limit: number, tenantId?: string) {
    const rows = await this.prisma.subscription.findMany({
      where: { OR: [{ name: ci(text) }, { externalId: ci(text) }], ...(tenantId ? { tenantId } : {}) },
      select: {
        id: true,
        name: true,
        externalId: true,
        state: true,
        tenant: { select: { name: true } },
        _count: { select: { resources: { where: { state: 'active' } }, resourceGroups: true } },
      },
      take,
    });
    return ranked(
      rows.map(
        (s): SearchResultDto => ({
          kind: 'subscription',
          id: s.id,
          title: s.name,
          subtitle: s.tenant?.name ?? null,
          link: `/inventory?subscriptionId=${s.id}`,
          matched: s.name.toLowerCase().includes(text.toLowerCase()) ? null : 'subscription id',
          facts: [
            { label: 'Subscription id', value: s.externalId },
            { label: 'Resource groups', value: String(s._count.resourceGroups) },
            { label: 'Resources', value: String(s._count.resources) },
          ],
          badge: s.state && s.state !== 'Enabled' ? { label: s.state, tone: 'warning' } : null,
        }),
      ),
      text,
      limit,
    );
  }

  private async organizations(text: string, take: number, limit: number, tenantId?: string) {
    const rows = await this.prisma.tenant.findMany({
      where: { OR: [{ name: ci(text) }, { externalId: ci(text) }], ...(tenantId ? { id: tenantId } : {}) },
      select: { id: true, name: true, externalId: true, providerKey: true, _count: { select: { subscriptions: true } } },
      take,
    });
    return ranked(
      rows.map(
        (t): SearchResultDto => ({
          kind: 'organization',
          id: t.id,
          title: t.name,
          subtitle: `${t.providerKey} · ${t._count.subscriptions} subscription${t._count.subscriptions === 1 ? '' : 's'}`,
          link: `/organizations#${t.id}`,
          matched: t.name.toLowerCase().includes(text.toLowerCase()) ? null : 'tenant id',
          facts: [{ label: 'Tenant id', value: t.externalId }],
          badge: null,
        }),
      ),
      text,
      limit,
    );
  }

  // ── Platform records ───────────────────────────────────────────────

  private async workItems(text: string, take: number, limit: number) {
    const rows = await this.prisma.workItem.findMany({
      where: { OR: [{ title: ci(text) }, ...(CUID.test(text) ? [{ id: text }] : [])] },
      select: { id: true, title: true, state: true, type: true, priority: true, assignee: true, dueDate: true },
      orderBy: { updatedAt: 'desc' },
      take,
    });
    const tone = { todo: 'neutral', in_progress: 'accent', blocked: 'danger', done: 'success' } as const;
    return ranked(
      rows.map(
        (w): SearchResultDto => ({
          kind: 'workItem',
          id: w.id,
          title: w.title,
          subtitle: `${w.type} · P${w.priority}${w.assignee ? ` · ${w.assignee}` : ''}`,
          link: `/work/${w.id}`,
          matched: null,
          facts: [
            { label: 'State', value: w.state.replace('_', ' ') },
            { label: 'Due', value: w.dueDate ? w.dueDate.toISOString().slice(0, 10) : '—' },
          ],
          badge: { label: w.state.replace('_', ' '), tone: tone[w.state] },
        }),
      ),
      text,
      limit,
    );
  }

  private async rules(text: string, take: number, limit: number) {
    const rows = await this.prisma.standardRule.findMany({
      where: { OR: [{ name: ci(text) }, { description: ci(text) }, { key: ci(text) }] },
      select: { id: true, name: true, description: true, severity: true, enabled: true, category: true, standard: { select: { name: true } } },
      take,
    });
    return ranked(
      rows.map(
        (r): SearchResultDto => ({
          kind: 'rule',
          id: r.id,
          title: r.name ?? r.description,
          subtitle: r.standard.name,
          link: `/standards?rule=${r.id}`,
          matched: null,
          facts: [
            { label: 'Severity', value: r.severity },
            { label: 'Category', value: r.category ?? '—' },
            { label: 'Enabled', value: r.enabled ? 'yes' : 'no' },
          ],
          badge: { label: r.severity, tone: r.severity === 'high' ? 'danger' : r.severity === 'medium' ? 'warning' : 'neutral' },
        }),
      ),
      text,
      limit,
    );
  }

  private async documents(text: string, take: number, limit: number) {
    const rows = await this.prisma.document.findMany({
      where: { title: ci(text) },
      select: {
        id: true,
        title: true,
        kind: true,
        updatedAt: true,
        updatedBy: true,
        workspace: { select: { scopeType: true, scopeId: true, title: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take,
    });
    return ranked(
      rows.map(
        (d): SearchResultDto => ({
          kind: 'document',
          id: d.id,
          title: d.title,
          subtitle: `${d.kind} · ${d.workspace.title}`,
          link:
            d.workspace.scopeType === 'resource'
              ? `/inventory/${d.workspace.scopeId}?tab=Docs&doc=${d.id}`
              : `/workspaces?scopeType=${d.workspace.scopeType}&scopeId=${d.workspace.scopeId}&doc=${d.id}`,
          matched: null,
          facts: [
            { label: 'Updated', value: d.updatedAt.toISOString().slice(0, 10) },
            { label: 'By', value: d.updatedBy ?? '—' },
          ],
          badge: null,
        }),
      ),
      text,
      limit,
    );
  }

  private async remediations(text: string, take: number, limit: number) {
    const rows = await this.prisma.remediationRun.findMany({
      where: { OR: [{ title: ci(text) }, ...(CUID.test(text) ? [{ id: text }] : [])] },
      select: { id: true, title: true, status: true, risk: true, createdAt: true, _count: { select: { targets: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return ranked(
      rows.map(
        (r): SearchResultDto => ({
          kind: 'remediation',
          id: r.id,
          title: r.title,
          subtitle: `${r._count.targets} resource${r._count.targets === 1 ? '' : 's'} · ${r.risk} risk`,
          link: `/remediation/${r.id}`,
          matched: null,
          facts: [{ label: 'Requested', value: r.createdAt.toISOString().slice(0, 10) }],
          badge: { label: r.status.replace('_', ' '), tone: r.status === 'failed' ? 'danger' : r.status === 'completed' ? 'success' : 'neutral' },
        }),
      ),
      text,
      limit,
    );
  }

  /** Sync runs are found by id only (paste one from a log line or notification). */
  private async syncRuns(text: string) {
    if (!CUID.test(text)) return { items: [], more: false };
    const r = await this.prisma.syncRun.findUnique({ where: { id: text } });
    if (!r) return { items: [], more: false };
    return {
      items: [
        {
          kind: 'syncRun' as const,
          id: r.id,
          title: `Inventory sync ${r.id.slice(0, 8)}`,
          subtitle: `${r.status} · ${r.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`,
          link: `/operations/syncs?run=${r.id}`,
          matched: 'run id',
          facts: [
            { label: 'Created', value: String(r.created) },
            { label: 'Updated', value: String(r.updated) },
            { label: 'Deleted', value: String(r.deleted) },
          ],
          badge: { label: r.status, tone: r.status === 'failed' ? ('danger' as const) : ('neutral' as const) },
        },
      ],
      more: false,
    };
  }

  private async users(text: string, take: number, limit: number) {
    const rows = await this.prisma.user.findMany({
      where: { OR: [{ name: ci(text) }, { email: ci(text) }] },
      select: { id: true, name: true, email: true, isActive: true, roles: { select: { role: { select: { key: true } } } } },
      take,
    });
    return ranked(
      rows.map(
        (u): SearchResultDto => ({
          kind: 'user',
          id: u.id,
          title: u.name || u.email,
          subtitle: u.email,
          link: `/settings/users?user=${u.id}`,
          matched: null,
          facts: [{ label: 'Roles', value: u.roles.map((r) => r.role.key).join(', ') || '—' }],
          badge: u.isActive ? null : { label: 'deactivated', tone: 'neutral' },
        }),
      ),
      text,
      limit,
    );
  }

  /** Audit events by request id or target id (exact) — the correlation handles you paste from logs. */
  private async audit(text: string, limit: number) {
    if (!(UUID.test(text) || CUID.test(text) || /^job:/.test(text))) return { items: [], more: false };
    const rows = await this.prisma.auditLog.findMany({
      where: { OR: [{ requestId: text }, { entityId: text }] },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    return {
      items: rows.slice(0, limit).map(
        (a): SearchResultDto => ({
          kind: 'audit',
          id: a.id,
          title: a.action,
          subtitle: `${a.actor ?? 'system'} · ${a.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`,
          link: `/settings/audit?${a.requestId === text ? 'requestId' : 'entityId'}=${encodeURIComponent(text)}`,
          matched: a.requestId === text ? 'request id' : 'target id',
          facts: [{ label: 'Target', value: `${a.entity}${a.entityId ? ` · ${a.entityId}` : ''}` }],
          badge: a.action.endsWith('.failed') ? { label: 'failed', tone: 'danger' } : null,
        }),
      ),
      more: rows.length > limit,
    };
  }
}
