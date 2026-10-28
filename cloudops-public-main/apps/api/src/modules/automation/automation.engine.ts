import type { Prisma as PrismaNS } from '@prisma/client';
import {
  AUTOMATION_TRIGGER_INFO,
  automationActionSchema,
  automationConditionsSchema,
  type AutomationAction,
  type AutomationActionResultDto,
  type AutomationConditions,
  type AutomationMatchDto,
  type AutomationTrigger,
  type SyncSummary,
} from '@cloudops/core';
import type { EventBus, Logger } from '@cloudops/kernel';
import { AppError } from '../../http/errors.js';
import type { Prisma } from '../../infra/prisma.js';
import type { FinopsService } from '../finops/finops.service.js';
import type { NotificationService } from '../notifications/notifications.service.js';
import type { WorkService } from '../work/work.service.js';
import {
  anomalyMatches,
  budgetMatches,
  complianceMatches,
  driftMatches,
  remediationFailedMatch,
  syncFailedMatch,
  unreachableMatches,
} from './matchers.js';

/** Most matches one firing acts on — a flood (say, 400 new failures) is capped and flagged, never fanned out. */
export const MAX_MATCHES_PER_RUN = 25;
/** Most notifications one action sends; the rest are summarised in one. */
const MAX_NOTIFICATIONS = 10;
/** Recorded run history is kept this long. */
export const AUTOMATION_RUN_RETENTION_DAYS = 90;

export interface RuleRow {
  id: string;
  name: string;
  trigger: string;
  conditions: PrismaNS.JsonValue;
  actions: PrismaNS.JsonValue;
}

/** Parse stored JSON defensively: a rule edited into an invalid shape is skipped, not crashed on. */
export function parseRule(
  r: RuleRow,
): { conditions: AutomationConditions; actions: AutomationAction[] } | null {
  const conditions = automationConditionsSchema.safeParse(r.conditions ?? {});
  const actions = Array.isArray(r.actions)
    ? r.actions.map((a) => automationActionSchema.safeParse(a))
    : [];
  if (!conditions.success || actions.some((a) => !a.success)) return null;
  return { conditions: conditions.data, actions: actions.map((a) => a.data!) };
}

const day = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Runs automation rules: listens to domain events, turns each into matches,
 * filters them by every enabled rule's conditions and performs the rule's
 * actions — notify people, raise work items (never twice for the same open
 * condition). Every firing is recorded. Nothing here changes the cloud.
 */
export class AutomationEngine {
  constructor(
    private readonly prisma: Prisma,
    private readonly notifications: NotificationService,
    private readonly work: WorkService,
    private readonly finops: FinopsService,
    private readonly logger: Logger,
  ) {}

  private async rulesFor(trigger: AutomationTrigger): Promise<RuleRow[]> {
    return this.prisma.automationRule.findMany({ where: { enabled: true, trigger } });
  }

  register(events: EventBus): void {
    // Never let a rule failure surface in the code path that emitted the event.
    const safe =
      <T>(fn: (e: T) => Promise<void>) =>
      async (e: T) => {
        try {
          await fn(e);
        } catch (err) {
          this.logger.warn('automation handler failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

    events.on(
      'sync.failed',
      safe(async (e) => {
        await this.fire('sync.failed', () => [syncFailedMatch(e.runId, e.error)]);
      }),
    );

    events.on(
      'sync.completed',
      safe(async (e) => {
        await this.fire('sync.unreachable', async () => {
          const run = await this.prisma.syncRun.findUnique({
            where: { id: e.runId },
            select: { summary: true },
          });
          return unreachableMatches(
            e.runId,
            (run?.summary as SyncSummary | null)?.accountErrors ?? [],
          );
        });
        if (e.changes > 0 || (e.deleted ?? 0) > 0) {
          await this.fire('drift.detected', async (c) => {
            const changes = await this.prisma.changeEvent.findMany({
              where: { syncRunId: e.runId },
              select: { resourceId: true, field: true },
            });
            return driftMatches(e.runId, changes, c);
          });
        }
      }),
    );

    events.on(
      'compliance.evaluated',
      safe(async (e) => {
        if (!e.newFailures.length) return;
        await this.fire('compliance.new-failures', (c) =>
          complianceMatches(e.newFailures, c, true),
        );
      }),
    );

    events.on(
      'finops.synced',
      safe(async () => {
        const month = day().slice(0, 7);
        await this.fire(
          'cost.anomaly',
          async (c) => {
            const a = await this.finops.costAnomalies({});
            return anomalyMatches(a.anomalies, c, a.currency);
          },
          day(),
        );
        await this.fire(
          'budget.threshold',
          async (c) => {
            const currency = await this.finops.reportingCurrency();
            return budgetMatches(await this.finops.budgetAlerts(), c, currency, month);
          },
          day(),
        );
      }),
    );

    events.on(
      'remediation.finished',
      safe(async (e) => {
        if (e.status !== 'failed' && e.status !== 'partial') return;
        await this.fire('remediation.failed', () => [
          remediationFailedMatch(e.runId, e.title, e.status, e.summary),
        ]);
      }),
    );
  }

  /**
   * Evaluate every enabled rule for a trigger. `build` produces the matches for
   * a rule's conditions (called once per rule — cheap sources build once and
   * filter). `occurrence` scopes notification de-duplication (e.g. the day).
   */
  async fire(
    trigger: AutomationTrigger,
    build: (c: AutomationConditions) => AutomationMatchDto[] | Promise<AutomationMatchDto[]>,
    occurrence?: string,
  ): Promise<void> {
    const rules = await this.rulesFor(trigger);
    for (const rule of rules) {
      const parsed = parseRule(rule);
      if (!parsed) {
        await this.record(
          rule,
          trigger,
          'failed',
          [],
          false,
          [],
          'The rule’s stored settings are invalid — edit and save it again.',
        );
        continue;
      }
      try {
        const matches = await build(parsed.conditions);
        await this.execute(
          rule,
          trigger,
          parsed.actions,
          matches,
          occurrence ?? `${trigger}:${Date.now()}`,
        );
      } catch (err) {
        await this.record(rule, trigger, 'failed', [], false, [], this.publicError(err, rule));
      }
    }
  }

  /** Perform a rule's actions on matches and record the run. Returns the run id. */
  async execute(
    rule: RuleRow,
    trigger: string,
    actions: AutomationAction[],
    all: AutomationMatchDto[],
    occurrence: string,
    manualBy?: string | null,
  ): Promise<string> {
    const matches = all.slice(0, MAX_MATCHES_PER_RUN);
    const truncated = all.length > matches.length;
    if (!matches.length)
      return this.record(rule, trigger, 'skipped', [], false, [], null, manualBy);

    const results: AutomationActionResultDto[] = [];
    for (const action of actions) {
      try {
        results.push(
          action.type === 'notify'
            ? await this.notify(rule, action, matches, truncated, all.length, occurrence)
            : await this.raiseWork(rule, action, matches),
        );
      } catch (err) {
        results.push({
          type: action.type,
          outcome: 'failed',
          count: 0,
          message: this.publicError(err, rule),
        });
      }
    }
    const failed = results.filter((r) => r.outcome === 'failed').length;
    const status = failed === 0 ? 'succeeded' : failed === results.length ? 'failed' : 'partial';
    return this.record(rule, trigger, status, matches, truncated, results, null, manualBy);
  }

  private async notify(
    rule: RuleRow,
    action: Extract<AutomationAction, { type: 'notify' }>,
    matches: AutomationMatchDto[],
    truncated: boolean,
    total: number,
    occurrence: string,
  ): Promise<AutomationActionResultDto> {
    const shown = matches.slice(0, MAX_NOTIFICATIONS);
    for (const m of shown) {
      await this.notifications.publish({
        category: 'automation',
        severity: action.severity,
        title: m.title,
        body: `${m.detail}\n\nRule: ${rule.name}`,
        link: m.link,
        entityType: 'automationRule',
        entityId: rule.id,
        audience: action.audience,
        dedupeKey: `automation:${rule.id}:${m.key}:${occurrence}`.slice(0, 300),
      });
    }
    const rest = total - shown.length;
    if (rest > 0) {
      await this.notifications.publish({
        category: 'automation',
        severity: action.severity,
        title: `…and ${rest} more from “${rule.name}”`,
        body: truncated ? `Only the first ${MAX_MATCHES_PER_RUN} matches were acted on.` : null,
        link: `/automation?rule=${rule.id}`,
        entityType: 'automationRule',
        entityId: rule.id,
        audience: action.audience,
        dedupeKey: `automation:${rule.id}:more:${occurrence}`.slice(0, 300),
      });
    }
    return {
      type: 'notify',
      outcome: 'done',
      count: shown.length + (rest > 0 ? 1 : 0),
      message: null,
    };
  }

  private async raiseWork(
    rule: RuleRow,
    action: Extract<AutomationAction, { type: 'create-work-item' }>,
    matches: AutomationMatchDto[],
  ): Promise<AutomationActionResultDto> {
    const sourceIds = matches.map((m) => `${rule.id}:${m.key}`.slice(0, 300));
    const open = await this.prisma.workItem.findMany({
      where: { sourceType: 'automation', sourceId: { in: sourceIds }, state: { not: 'done' } },
      select: { sourceId: true },
    });
    const alreadyOpen = new Set(open.map((o) => o.sourceId));
    let created = 0;
    for (const [i, m] of matches.entries()) {
      if (alreadyOpen.has(sourceIds[i]!)) continue;
      const due =
        action.dueInDays !== undefined
          ? new Date(Date.now() + action.dueInDays * 86_400_000).toISOString().slice(0, 10)
          : undefined;
      await this.work.create(
        {
          title: m.title.slice(0, 200),
          description: `${m.detail}\n\nRaised automatically by the rule “${rule.name}” (${AUTOMATION_TRIGGER_INFO[rule.trigger as AutomationTrigger]?.label ?? rule.trigger}).`,
          type: action.workType,
          state: 'todo',
          priority: action.priority,
          ...(action.assignee ? { assignee: action.assignee } : {}),
          ...(due ? { dueDate: due } : {}),
          scopes: m.resourceIds.map((id) => ({ scopeType: 'resource' as const, scopeId: id })),
          source: {
            type: 'automation',
            id: sourceIds[i]!,
            label: `${rule.name} · ${m.title}`.slice(0, 300),
          },
        },
        { id: null, name: `Automation: ${rule.name}` },
      );
      created++;
    }
    const skipped = matches.length - created;
    return {
      type: 'create-work-item',
      outcome: created ? 'done' : 'skipped',
      count: created,
      message: skipped ? `${skipped} already had an open work item` : null,
    };
  }

  private async record(
    rule: RuleRow,
    trigger: string,
    status: string,
    matches: AutomationMatchDto[],
    truncated: boolean,
    actions: AutomationActionResultDto[],
    error: string | null,
    manualBy?: string | null,
  ): Promise<string> {
    const [run] = await this.prisma.$transaction([
      this.prisma.automationRun.create({
        data: {
          ruleId: rule.id,
          trigger,
          status,
          error,
          detail: {
            matched: matches.length,
            truncated,
            manualBy: manualBy ?? null,
            matches: matches.map((m) => ({ key: m.key, title: m.title, link: m.link })),
            actions,
          } as unknown as PrismaNS.InputJsonValue,
        },
      }),
      this.prisma.automationRule.update({
        where: { id: rule.id },
        data: { lastRunAt: new Date(), ...(matches.length ? { runCount: { increment: 1 } } : {}) },
      }),
    ]);
    return run.id;
  }

  /**
   * Run history is readable by everyone, so only our own, user-facing errors are
   * stored there; anything unexpected is logged in full and summarised.
   */
  private publicError(err: unknown, rule: RuleRow): string {
    if (err instanceof AppError) return err.message.slice(0, 300);
    this.logger.error('automation rule failed', {
      ruleId: rule.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'Unexpected error — the details are in the API log.';
  }

  /** Housekeeping: drop run history past retention. */
  async purge(): Promise<number> {
    const before = new Date(Date.now() - AUTOMATION_RUN_RETENTION_DAYS * 86_400_000);
    return (await this.prisma.automationRun.deleteMany({ where: { createdAt: { lt: before } } }))
      .count;
  }
}
