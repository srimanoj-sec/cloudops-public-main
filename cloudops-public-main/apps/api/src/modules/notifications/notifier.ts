import { formatMoney, type SyncSummary } from '@cloudops/core';
import type { EventBus, Logger } from '@cloudops/kernel';
import { config } from '../../env.js';
import type { Prisma } from '../../infra/prisma.js';
import { onJobFailure } from '../../infra/bullmq.js';
import type { FinopsService } from '../finops/finops.service.js';
import type { NotificationService } from './notifications.service.js';

/** Cost-sync outcomes that won't fix themselves (transient ones are retried automatically). */
const COST_PROBLEMS = new Set(['no-access', 'unsupported', 'unconverted', 'error']);
/** Anomalies notified per cost sync; the rest are summarised in one notification. */
const MAX_ANOMALY_NOTIFICATIONS = 5;
/** Warn about work due within this window, and exemptions expiring within this one. */
const DUE_SOON_MS = 24 * 3_600_000;
const EXEMPTION_WARNING_MS = 7 * 86_400_000;

const day = (d: Date) => d.toISOString().slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Turns domain events and scheduled checks into notifications. Every rule for
 * "who gets told what" lives here, so it can be read in one place. Each
 * notification has a dedupe key: re-running a check, retrying a job or
 * replaying an event never notifies twice about the same condition.
 */
export class Notifier {
  constructor(
    private readonly prisma: Prisma,
    private readonly notifications: NotificationService,
    private readonly finops: FinopsService,
    private readonly logger: Logger,
  ) {}

  register(events: EventBus): void {
    const n = this.notifications;

    events.on('sync.failed', async (e) => {
      await n.publish({
        category: 'sync',
        severity: 'high',
        title: 'Inventory sync failed',
        body: e.error,
        link: `/operations/syncs?run=${e.runId}`,
        entityType: 'syncRun',
        entityId: e.runId,
        audience: 'inventory.sync',
        dedupeKey: `sync.failed:${e.runId}`,
      });
    });

    events.on('sync.completed', async (e) => {
      const run = await this.prisma.syncRun.findUnique({ where: { id: e.runId }, select: { summary: true } });
      const summary = run?.summary as SyncSummary | null;
      for (const err of summary?.accountErrors ?? []) {
        await n.publish({
          category: 'sync',
          severity: 'high',
          title: `Organization “${err.account}” could not be reached`,
          body: `${err.message} Its resources were not refreshed. Check the credentials on the Providers page.`,
          link: '/providers',
          entityType: 'syncRun',
          entityId: e.runId,
          audience: 'provider.manage',
          dedupeKey: `sync.account:${err.account}:${e.runId}`,
        });
      }
      if (summary?.skipped?.length) {
        await n.publish({
          category: 'sync',
          severity: 'medium',
          title: `Sync skipped ${plural(summary.skipped.length, 'subscription')}`,
          body: summary.skipped.slice(0, 5).join('; '),
          link: `/operations/syncs?run=${e.runId}`,
          entityType: 'syncRun',
          entityId: e.runId,
          audience: 'inventory.sync',
          dedupeKey: `sync.skipped:${e.runId}`,
        });
      }
      if (e.deleted) {
        await n.publish({
          category: 'sync',
          severity: 'info',
          title: `${plural(e.deleted, 'resource')} no longer exist in the provider`,
          body: 'They were flagged deleted and dropped from totals. Their history and cost are kept.',
          link: '/inventory?state=deleted',
          entityType: 'syncRun',
          entityId: e.runId,
          dedupeKey: `sync.deleted:${e.runId}`,
        });
      }
    });

    events.on('finops.synced', async (e) => {
      const today = day(new Date());
      for (const r of (e.results ?? []).filter((x) => COST_PROBLEMS.has(x.outcome))) {
        await n.publish({
          category: 'cost',
          severity: 'medium',
          title: `Cost for “${r.name}” was not updated`,
          body: r.message,
          link: '/finops?tab=sync',
          entityType: 'subscription',
          entityId: r.subscriptionId,
          audience: 'finops.sync',
          dedupeKey: `cost.problem:${r.subscriptionId}:${r.outcome}:${today}`,
        });
      }
      await this.checkBudgets();
      await this.checkAnomalies();
    });

    events.on('compliance.evaluated', async (e) => {
      const serious = e.newFailures.filter((f) => f.severity === 'high');
      const stamp = day(new Date());
      for (const f of serious.slice(0, 5)) {
        await n.publish({
          category: 'compliance',
          severity: 'high',
          title: `New high-severity finding: ${f.ruleName}`,
          body: `${plural(f.resourceIds.length, 'resource')} started failing this check.`,
          link: `/standards?rule=${f.ruleId}`,
          entityType: 'standardRule',
          entityId: f.ruleId,
          audience: 'remediation.request',
          dedupeKey: `compliance.new:${f.ruleId}:${stamp}:${f.resourceIds.length}`,
        });
      }
    });

    events.on('remediation.requested', async (e) => {
      if (!e.needsApproval) return;
      await n.publish({
        category: 'remediation',
        severity: e.risk === 'high' ? 'high' : 'medium',
        title: `Approval needed: ${e.title}`,
        body: `${e.requestedBy ?? 'Someone'} asked to change ${plural(e.targets, 'resource')} (${e.risk} risk).`,
        link: `/remediation/${e.runId}`,
        entityType: 'remediationRun',
        entityId: e.runId,
        audience: 'remediation.approve',
        actorId: e.requestedById,
        dedupeKey: `remediation.requested:${e.runId}`,
      });
    });

    events.on('remediation.decided', async (e) => {
      if (!e.requestedById) return;
      await n.publish({
        category: 'remediation',
        severity: e.approved ? 'info' : 'medium',
        title: `${e.approved ? 'Approved' : 'Rejected'}: ${e.title}`,
        body: `${e.decidedBy ?? 'An approver'} ${e.approved ? 'approved' : 'rejected'} your remediation request.`,
        link: `/remediation/${e.runId}`,
        entityType: 'remediationRun',
        entityId: e.runId,
        userId: e.requestedById,
        dedupeKey: `remediation.decided:${e.runId}`,
      });
    });

    events.on('remediation.finished', async (e) => {
      const failed = e.summary.failed > 0;
      const text = `${e.summary.succeeded} changed · ${e.summary.verified} verified · ${e.summary.failed} failed · ${e.summary.skipped} skipped`;
      if (e.requestedById) {
        await n.publish({
          category: 'remediation',
          severity: failed ? 'high' : 'info',
          title: `${failed ? 'Remediation finished with failures' : 'Remediation completed'}: ${e.title}`,
          body: text,
          link: `/remediation/${e.runId}`,
          entityType: 'remediationRun',
          entityId: e.runId,
          userId: e.requestedById,
          dedupeKey: `remediation.finished:${e.runId}:${e.requestedById}`,
        });
      }
      if (failed) {
        await n.publish({
          category: 'remediation',
          severity: 'high',
          title: `Remediation failed on ${plural(e.summary.failed, 'resource')}: ${e.title}`,
          body: text,
          link: `/remediation/${e.runId}`,
          entityType: 'remediationRun',
          entityId: e.runId,
          audience: 'remediation.execute',
          dedupeKey: `remediation.failed:${e.runId}`,
        });
      }
    });

    events.on('work.assigned', async (e) => {
      for (const u of (await n.resolveUsers([e.assignee])).filter((x) => x.id !== e.actorId)) {
        await n.publish({
          category: 'work',
          severity: 'info',
          title: `Assigned to you: ${e.title}`,
          body: e.actor ? `by ${e.actor}` : null,
          link: `/work/${e.itemId}`,
          entityType: 'workItem',
          entityId: e.itemId,
          userId: u.id,
          dedupeKey: `work.assigned:${e.itemId}:${u.id}:${Date.now()}`,
        });
      }
    });

    events.on('work.mentioned', async (e) => {
      for (const u of (await n.mentionedUsers(e.body)).filter((x) => x.id !== e.actorId)) {
        await n.publish({
          category: 'work',
          severity: 'info',
          title: `${e.actor ?? 'Someone'} mentioned you on “${e.title}”`,
          link: `/work/${e.itemId}`,
          entityType: 'workItem',
          entityId: e.itemId,
          userId: u.id,
          dedupeKey: `work.mentioned:${e.itemId}:${u.id}:${Date.now()}`,
        });
      }
    });

    onJobFailure((f) => {
      void n.publish({
        category: 'system',
        severity: 'high',
        title: `Background job failed: ${f.queue} · ${f.name}`,
        body: f.error,
        link: `/settings/system?queue=${encodeURIComponent(f.queue)}`,
        entityType: 'job',
        entityId: `${f.queue}:${f.jobId}`,
        audience: 'system.read',
        dedupeKey: `job.failed:${f.queue}:${f.jobId}`,
      });
    });
  }

  /** Budgets over, or forecast over their alert threshold — once per budget, month and status. */
  async checkBudgets(): Promise<void> {
    try {
      const month = day(new Date()).slice(0, 7);
      for (const b of await this.finops.budgetAlerts()) {
        const cur = config.COST_CURRENCY;
        await this.notifications.publish({
          category: 'cost',
          severity: b.status === 'over' ? 'high' : 'medium',
          title: b.status === 'over' ? `Budget exceeded: ${b.name}` : `Budget at risk: ${b.name}`,
          body:
            b.status === 'over'
              ? `${formatMoney(b.spent, cur, { compact: true })} spent of ${formatMoney(b.amount, cur, { compact: true })} this month (${b.scopeName}).`
              : `Forecast ${formatMoney(b.forecast, cur, { compact: true })} is ${b.forecastPercent}% of the ${formatMoney(b.amount, cur, { compact: true })} budget (${b.scopeName}).`,
          link: '/finops?tab=budgets',
          entityType: 'budget',
          entityId: b.id,
          audience: 'finops.sync',
          dedupeKey: `budget:${b.id}:${month}:${b.status}`,
        });
      }
    } catch (err) {
      this.logger.warn('budget check failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Material cost anomalies on the latest day — the biggest few individually, the rest summarised. */
  async checkAnomalies(): Promise<void> {
    try {
      const a = await this.finops.costAnomalies({});
      if (!a.latestDate || a.flagged === 0) return;
      for (const x of a.anomalies.slice(0, MAX_ANOMALY_NOTIFICATIONS)) {
        await this.notifications.publish({
          category: 'cost',
          severity: x.monthlyImpact >= a.minDailyDelta * 30 * 10 ? 'high' : 'medium',
          title:
            x.kind === 'spike'
              ? `Cost spike: ${x.name}`
              : x.kind === 'new-region'
                ? `New spend in region ${x.name}`
                : `New spend: ${x.name}`,
          body: x.reason,
          link: x.resourceId ? `/inventory/${x.resourceId}?tab=Cost` : '/finops?tab=anomalies',
          entityType: x.resourceId ? 'resource' : 'costAnomaly',
          entityId: x.resourceId ?? x.externalId,
          audience: 'finops.sync',
          dedupeKey: `cost.anomaly:${x.externalId}:${x.latestDate}`,
        });
      }
      if (a.flagged > MAX_ANOMALY_NOTIFICATIONS) {
        await this.notifications.publish({
          category: 'cost',
          severity: 'medium',
          title: `${a.flagged} cost anomalies on ${a.latestDate}`,
          body: `About ${formatMoney(a.totalMonthlyImpact, a.currency, { compact: true })}/month if they persist.`,
          link: '/finops?tab=anomalies',
          entityType: 'costAnomaly',
          audience: 'finops.sync',
          dedupeKey: `cost.anomalies:${a.latestDate}`,
        });
      }
    } catch (err) {
      this.logger.warn('anomaly check failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Scheduled (housekeeping): work due soon or overdue, exemptions expiring or
   * expired, and retention. Safe to run as often as you like — dedupe keys make
   * every reminder fire once per condition.
   */
  async runScheduledChecks(now = new Date()): Promise<{ reminders: number; purged: number }> {
    let reminders = 0;
    const items = await this.prisma.workItem.findMany({
      where: { state: { not: 'done' }, dueDate: { not: null, lt: new Date(now.getTime() + DUE_SOON_MS) } },
      select: { id: true, title: true, dueDate: true, assignee: true },
      take: 500,
    });
    for (const w of items) {
      const overdue = w.dueDate! < now;
      const users = w.assignee ? await this.notifications.resolveUsers([w.assignee]) : [];
      const base = {
        category: 'work' as const,
        severity: overdue ? ('high' as const) : ('medium' as const),
        title: overdue ? `Overdue: ${w.title}` : `Due within a day: ${w.title}`,
        body: `Due ${w.dueDate!.toLocaleDateString('en-GB', { dateStyle: 'medium' })}${w.assignee ? ` · assigned to ${w.assignee}` : ' · unassigned'}`,
        link: `/work/${w.id}`,
        entityType: 'workItem',
        entityId: w.id,
      };
      const key = `work.${overdue ? 'overdue' : 'due'}:${w.id}:${day(w.dueDate!)}`;
      if (users.length) {
        for (const u of users) await this.notifications.publish({ ...base, userId: u.id, dedupeKey: `${key}:${u.id}` });
      } else {
        await this.notifications.publish({ ...base, audience: 'work.manage', dedupeKey: key });
      }
      reminders++;
    }

    const exemptions = await this.prisma.complianceExemption.findMany({
      where: { expiresAt: { not: null, lt: new Date(now.getTime() + EXEMPTION_WARNING_MS) } },
      select: {
        id: true,
        expiresAt: true,
        resource: { select: { id: true, name: true } },
        rule: { select: { id: true, name: true, description: true } },
      },
      take: 500,
    });
    for (const x of exemptions) {
      const expired = x.expiresAt! <= now;
      await this.notifications.publish({
        category: 'compliance',
        severity: expired ? 'medium' : 'low',
        title: `${expired ? 'Exemption expired' : 'Exemption expires soon'}: ${x.resource.name}`,
        body: `“${x.rule.name ?? x.rule.description}” — ${expired ? 'the failure counts again from the next evaluation' : `until ${x.expiresAt!.toLocaleDateString('en-GB', { dateStyle: 'medium' })}`}. Renew it with a reason, or fix the resource.`,
        link: '/standards?tab=exemptions',
        entityType: 'exemption',
        entityId: x.id,
        audience: 'standards.exempt',
        dedupeKey: `exemption.${expired ? 'expired' : 'expiring'}:${x.id}:${day(x.expiresAt!)}`,
      });
      reminders++;
    }

    const purged = await this.notifications.purge();
    return { reminders, purged };
  }
}
