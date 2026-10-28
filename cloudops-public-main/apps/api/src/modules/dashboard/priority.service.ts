import {
  formatMoney,
  type CostInsightsBlock,
  type PriorityItemDto,
  type SyncSummary,
  type UrgentWorkDto,
} from '@cloudops/core';
import { config } from '../../env.js';
import type { Prisma } from '../../infra/prisma.js';
import type { FinopsService } from '../finops/finops.service.js';
import type { WorkService } from '../work/work.service.js';
import { scorePriority, type Severity } from './priority.js';

/** Exemptions expiring within this window are surfaced. */
const EXEMPTION_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;
const MAX_ITEMS = 15;

type Item = Omit<PriorityItemDto, 'score' | 'factors'> & Parameters<typeof scorePriority>[0] & { template?: string | null };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The command center's priority queue: every signal that needs a decision,
 * ranked by a transparent score (see priority.ts). Each source is one bounded
 * query; the org switcher scopes everything that belongs to an organization.
 */
export class PriorityService {
  constructor(
    private readonly prisma: Prisma,
    private readonly finops: FinopsService,
    private readonly work: WorkService,
    /** Whether a remediation action exists for a rule's library template. */
    private readonly isRemediable: (template: string | null) => boolean = () => false,
  ) {}

  async compute(
    tenantId: string | undefined,
    estateMonthly: number,
  ): Promise<{ priorities: PriorityItemDto[]; costInsights: CostInsightsBlock; urgentWork: UrgentWorkDto[] }> {
    const money = (n: number) => formatMoney(n, config.COST_CURRENCY, { compact: true });
    const [compliance, cost, operations, work, hygiene] = await Promise.all([
      this.compliance(tenantId),
      this.cost(tenantId),
      this.operations(tenantId),
      this.workItems(tenantId),
      this.hygiene(tenantId),
    ]);
    // The owner-present rule already reports unowned resources; don't list them twice.
    const ownerRule = compliance.some((c) => c.template === 'owner-present');
    const items: Item[] = [
      ...compliance,
      ...cost.items,
      ...operations,
      ...work.items,
      ...hygiene.filter((h) => !(ownerRule && h.kind === 'ownership')),
    ];
    const priorities = items
      .map((i): PriorityItemDto => {
        const { score, factors } = scorePriority({ ...i, estateMonthly }, money);
        return {
          id: i.id,
          kind: i.kind,
          severity: i.severity,
          title: i.title,
          detail: i.detail,
          affected: i.affected,
          costImpact: i.costImpact,
          link: i.link,
          source: i.source,
          remediable: i.remediable,
          score,
          factors,
        };
      })
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, MAX_ITEMS);
    return { priorities, costInsights: cost.insights, urgentWork: work.urgent };
  }

  // ── Compliance: one item per failing rule ───────────────────────────

  private async compliance(tenantId?: string): Promise<Item[]> {
    const rows = await this.prisma.$queryRaw<
      { ruleId: string; name: string | null; description: string; severity: string; category: string | null; template: string | null; failing: number; prod: number; cost: number }[]
    >`
      SELECT sr.id AS "ruleId", sr.name, sr.description, sr.severity, sr.category, sr.template,
             count(*)::int AS failing,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM jsonb_each_text(r.tags || coalesce(r."platformTags", '{}'::jsonb)) t
               WHERE lower(t.key) IN ('env', 'environment') AND t.value ~* '^(prod|production|prd|live)([-_ ].*)?$'
             ))::int AS prod,
             coalesce(sum(r."costMonthly"), 0)::float AS cost
      FROM "ComplianceResult" c
      JOIN "StandardRule" sr ON sr.id = c."ruleId" AND sr.enabled
      JOIN "Resource" r ON r.id = c."scopeId" AND r.state = 'active'
      LEFT JOIN "Subscription" s ON s.id = r."subscriptionId"
      WHERE c."scopeType" = 'resource' AND NOT c.passed AND NOT c.exempt
        AND (${tenantId ?? null}::text IS NULL OR s."tenantId" = ${tenantId ?? null})
      GROUP BY sr.id`;
    return rows.map((r) => {
      const name = r.name ?? r.description;
      const costRule = r.category === 'cost';
      return {
        id: `rule:${r.ruleId}`,
        kind: 'compliance' as const,
        severity: (r.severity === 'high' ? 'high' : r.severity === 'medium' ? 'medium' : 'low') as Severity,
        title: name,
        detail: `${plural(r.failing, 'resource')} failing${r.prod ? `, ${r.prod} in production` : ''}${costRule && r.cost > 0 ? ` · ${formatMoney(r.cost, config.COST_CURRENCY, { compact: true })}/mo on them` : ''}`,
        affected: r.failing,
        production: r.prod,
        costImpact: costRule && r.cost > 0 ? r.cost : null,
        link: `/standards?rule=${r.ruleId}`,
        source: { type: 'rule', id: r.ruleId, label: name },
        remediable: this.isRemediable(r.template),
        template: r.template,
      };
    });
  }

  // ── Cost: anomalies, budgets, orphaned spend + the dashboard's cost insights ──

  private async cost(tenantId?: string): Promise<{ items: Item[]; insights: CostInsightsBlock }> {
    const money = (n: number) => formatMoney(n, config.COST_CURRENCY, { compact: true });
    const [anomalies, overview, budgets, subs] = await Promise.all([
      this.finops.costAnomalies({ tenantId }),
      this.finops.overview({ tenantId }),
      this.finops.budgetAlerts(),
      tenantId ? this.prisma.subscription.findMany({ where: { tenantId }, select: { id: true } }) : Promise.resolve([]),
    ]);
    const items: Item[] = [];

    for (const a of anomalies.anomalies.slice(0, 5)) {
      items.push({
        id: `anomaly:${a.externalId}:${a.latestDate}`,
        kind: 'cost-anomaly',
        severity: a.monthlyImpact >= anomalies.minDailyDelta * 30 * 10 ? 'high' : 'medium',
        title: a.kind === 'spike' ? `Cost spike: ${a.name}` : a.kind === 'new-region' ? `New spend in ${a.name}` : `New spend: ${a.name}`,
        detail: a.reason,
        affected: a.resourceId ? 1 : null,
        costImpact: a.monthlyImpact,
        link: a.resourceId ? `/inventory/${a.resourceId}?tab=Cost` : '/finops?tab=anomalies',
        source: { type: 'costAnomaly', id: `${a.externalId}@${a.latestDate}`, label: `${a.name} on ${a.latestDate}` },
        remediable: false,
      });
    }

    const subIds = new Set(subs.map((s) => s.id));
    const inScope = (b: (typeof budgets)[number]) =>
      !tenantId || (b.scopeType === 'organization' && b.scopeId === tenantId) || (b.scopeType === 'subscription' && b.scopeId != null && subIds.has(b.scopeId));
    for (const b of budgets.filter(inScope)) {
      const over = b.status === 'over';
      items.push({
        id: `budget:${b.id}`,
        kind: 'budget',
        severity: over ? 'high' : 'medium',
        title: over ? `Budget exceeded: ${b.name}` : `Budget at risk: ${b.name}`,
        detail: over
          ? `${money(b.spent)} spent of ${money(b.amount)} (${b.percentUsed}%) · ${b.scopeName}`
          : `Forecast ${money(b.forecast)} = ${b.forecastPercent}% of ${money(b.amount)} · ${b.scopeName}`,
        affected: null,
        costImpact: over ? b.spent - b.amount : Math.max(0, b.forecast - b.amount),
        link: '/finops?tab=budgets',
        source: { type: 'budget', id: b.id, label: b.name },
        remediable: false,
      });
    }

    const deleted = overview.unattributed.byReason.find((r) => r.reason === 'deleted');
    if (deleted && deleted.cost > 0) {
      items.push({
        id: 'orphaned-spend',
        kind: 'orphaned-spend',
        severity: 'high',
        title: 'Deleted resources are still billing',
        detail: `${money(deleted.cost)} in the last 30 days on ${plural(deleted.count, 'resource')} that no longer exist in the inventory — often leftovers of a deleted resource group.`,
        affected: deleted.count,
        costImpact: deleted.cost,
        link: '/finops?tab=unattributed',
        source: { type: 'orphanedSpend', id: 'deleted', label: 'Spend on deleted resources' },
        remediable: false,
      });
    }

    const atRisk = budgets.filter((b) => inScope(b) && b.status === 'at-risk').length;
    const overCount = budgets.filter((b) => inScope(b) && b.status === 'over').length;
    return {
      items,
      insights: {
        monthToDate: overview.latestDate ? overview.month.toDate : null,
        forecast: overview.latestDate ? overview.month.forecast : null,
        lastMonthToDate: overview.latestDate ? overview.month.lastMonthToDate : null,
        budgetsAtRisk: atRisk,
        budgetsOver: overCount,
        savingsOpportunity: overview.savings.total,
        savingsCount: overview.savings.count,
        orphanedSpend: deleted?.cost ?? 0,
      },
    };
  }

  // ── Operations: sync health, unreachable organizations, pending approvals ──

  private async operations(tenantId?: string): Promise<Item[]> {
    const items: Item[] = [];
    const [latest, lastCompleted, pending] = await Promise.all([
      this.prisma.syncRun.findFirst({ orderBy: { createdAt: 'desc' } }),
      this.prisma.syncRun.findFirst({ where: { status: 'completed' }, orderBy: { finishedAt: 'desc' } }),
      this.prisma.remediationRun.findMany({ where: { status: 'pending_approval' }, select: { id: true, title: true, createdAt: true } }),
    ]);
    if (latest?.status === 'failed') {
      items.push({
        id: `sync:${latest.id}`,
        kind: 'sync',
        severity: 'high',
        title: 'The last inventory sync failed',
        detail: latest.error?.slice(0, 200) ?? 'No error recorded.',
        affected: null,
        costImpact: null,
        link: `/operations/syncs?run=${latest.id}`,
        source: { type: 'syncRun', id: latest.id, label: `Sync ${latest.id.slice(0, 8)}` },
        remediable: false,
      });
    }
    const finished = lastCompleted?.finishedAt;
    const staleDays = finished ? Math.floor((Date.now() - finished.getTime()) / DAY_MS) : null;
    if (!finished || (staleDays ?? 0) >= 1) {
      items.push({
        id: 'sync:stale',
        kind: 'sync',
        severity: !finished || (staleDays ?? 0) >= 3 ? 'high' : 'medium',
        title: finished ? `Inventory is ${plural(staleDays!, 'day')} old` : 'The estate has never been synced',
        detail: 'Everything on this page is served from the last completed sync. Run a sync to refresh it.',
        affected: null,
        costImpact: null,
        overdueDays: staleDays ?? undefined,
        link: '/operations/syncs',
        source: null,
        remediable: false,
      });
    }
    const summary = lastCompleted?.summary as SyncSummary | null;
    for (const err of summary?.accountErrors ?? []) {
      if (tenantId) continue; // an unreachable org can't be attributed to a tenant scope reliably
      items.push({
        id: `provider:${err.account}`,
        kind: 'provider',
        severity: 'critical',
        title: `Organization “${err.account}” can’t be reached`,
        detail: `${err.message.slice(0, 180)} Its inventory and cost are going stale.`,
        affected: null,
        costImpact: null,
        link: '/providers',
        source: { type: 'provider', id: err.account, label: err.account },
        remediable: false,
      });
    }
    if (pending.length) {
      const oldest = Math.floor((Date.now() - Math.min(...pending.map((p) => p.createdAt.getTime()))) / DAY_MS);
      items.push({
        id: 'approvals',
        kind: 'approval',
        severity: 'medium',
        title: `${plural(pending.length, 'remediation')} waiting for approval`,
        detail: pending.slice(0, 3).map((p) => p.title).join(' · '),
        affected: null,
        costImpact: null,
        overdueDays: oldest,
        link: '/remediation?status=pending_approval',
        source: null,
        remediable: false,
      });
    }
    return items;
  }

  // ── Work: overdue items + the urgent list ─────────────────────────

  private async workItems(tenantId?: string): Promise<{ items: Item[]; urgent: UrgentWorkDto[] }> {
    const open = (await this.work.list({ tenantId })).filter((w) => w.state !== 'done');
    const now = Date.now();
    const overdue = open.filter((w) => w.dueDate && new Date(w.dueDate).getTime() < now);
    const items: Item[] = overdue.slice(0, 5).map((w) => ({
      id: `work:${w.id}`,
      kind: 'work' as const,
      severity: (w.priority <= 1 ? 'high' : w.priority === 2 ? 'medium' : 'low') as Severity,
      title: `Overdue: ${w.title}`,
      detail: `P${w.priority} · ${w.assignee ?? 'unassigned'} · due ${w.dueDate!.slice(0, 10)}`,
      affected: null,
      costImpact: null,
      overdueDays: Math.floor((now - new Date(w.dueDate!).getTime()) / DAY_MS),
      link: `/work/${w.id}`,
      source: null,
      remediable: false,
    }));
    const urgent: UrgentWorkDto[] = [...open]
      .sort((a, b) => {
        const ao = a.dueDate && new Date(a.dueDate).getTime() < now ? 0 : 1;
        const bo = b.dueDate && new Date(b.dueDate).getTime() < now ? 0 : 1;
        return ao - bo || a.priority - b.priority || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
      })
      .slice(0, 5)
      .map((w) => ({
        id: w.id,
        title: w.title,
        priority: w.priority,
        state: w.state,
        assignee: w.assignee,
        dueDate: w.dueDate,
        overdue: Boolean(w.dueDate && new Date(w.dueDate).getTime() < now),
        scope: w.links[0] ? { type: w.links[0].scopeType, id: w.links[0].scopeId, name: w.links[0].scopeName } : null,
      }));
    return { items, urgent };
  }

  // ── Hygiene: ownership, expiring exemptions, recent drift ─────────

  private async hygiene(tenantId?: string): Promise<Item[]> {
    const scope = tenantId ? { subscription: { tenantId } } : {};
    const soon = new Date(Date.now() + EXEMPTION_WINDOW_DAYS * DAY_MS);
    const [unowned, active, expiring, drift] = await Promise.all([
      this.prisma.resource.count({ where: { state: 'active', owner: null, ...scope } }),
      this.prisma.resource.count({ where: { state: 'active', ...scope } }),
      this.prisma.complianceExemption.count({ where: { expiresAt: { not: null, lt: soon }, resource: scope } }),
      this.prisma.changeEvent.count({ where: { detectedAt: { gt: new Date(Date.now() - DAY_MS) }, resource: scope } }),
    ]);
    const items: Item[] = [];
    if (unowned > 0) {
      items.push({
        id: 'ownership',
        kind: 'ownership',
        severity: unowned / Math.max(1, active) > 0.25 ? 'medium' : 'low',
        title: `${plural(unowned, 'resource')} without an owner`,
        detail: `${Math.round((unowned / Math.max(1, active)) * 100)}% of active resources have no owner tag — nobody is accountable for their cost, patching or clean-up.`,
        affected: unowned,
        costImpact: null,
        link: '/inventory?owners=__unassigned__',
        source: { type: 'ownership', id: 'unowned', label: 'Resources without an owner' },
        remediable: true,
      });
    }
    if (expiring > 0) {
      items.push({
        id: 'exemptions',
        kind: 'exemption',
        severity: 'low',
        title: `${plural(expiring, 'exemption')} expiring within ${EXEMPTION_WINDOW_DAYS} days`,
        detail: 'When an exemption lapses the failure counts again. Renew it with a reason, or fix the resource.',
        affected: expiring,
        costImpact: null,
        link: '/standards?tab=exemptions',
        source: null,
        remediable: false,
      });
    }
    if (drift > 0) {
      items.push({
        id: 'drift',
        kind: 'drift',
        severity: 'low',
        title: `${plural(drift, 'configuration change')} in the last 24 hours`,
        detail: 'Detected by sync — check they were intended.',
        affected: drift,
        costImpact: null,
        link: '/operations/drift',
        source: null,
        remediable: false,
      });
    }
    return items;
  }
}
