import type { Prisma as PrismaNS } from '@prisma/client';
import {
  AUTOMATION_TRIGGER_INFO,
  PERMISSIONS,
  type AutomationAction,
  type AutomationActionResultDto,
  type AutomationMatchDto,
  type AutomationPreviewDto,
  type AutomationRuleDto,
  type AutomationRuleInput,
  type AutomationRunDto,
  type AutomationRunsQuery,
  type AutomationTrigger,
  type SyncSummary,
} from '@cloudops/core';
import { AppError } from '../../http/errors.js';
import type { Prisma } from '../../infra/prisma.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import type { FinopsService } from '../finops/finops.service.js';
import type { StandardsService } from '../standards/standards.service.js';
import { MAX_MATCHES_PER_RUN, parseRule, type AutomationEngine } from './automation.engine.js';
import {
  anomalyMatches,
  budgetMatches,
  complianceMatches,
  driftMatches,
  remediationFailedMatch,
  syncFailedMatch,
  unreachableMatches,
} from './matchers.js';

type RuleWithRun = PrismaNS.AutomationRuleGetPayload<{
  include: { runs: { take: 1; orderBy: { createdAt: 'desc' } } };
}>;

interface RunDetail {
  matched?: number;
  truncated?: boolean;
  manualBy?: string | null;
  matches?: { key: string; title: string; link: string | null }[];
  actions?: AutomationActionResultDto[];
}

function toRuleDto(r: RuleWithRun): AutomationRuleDto {
  const parsed = parseRule(r);
  const last = r.runs[0];
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    enabled: r.enabled,
    trigger: r.trigger as AutomationTrigger,
    conditions: parsed?.conditions ?? {},
    actions: parsed?.actions ?? [],
    createdBy: r.createdBy,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    runCount: r.runCount,
    lastRun: last
      ? {
          status: last.status,
          matched: (last.detail as RunDetail | null)?.matched ?? 0,
          createdAt: last.createdAt.toISOString(),
        }
      : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const LAST_RUN = { runs: { take: 1, orderBy: { createdAt: 'desc' as const } } };

/** Rule management, run history, and "what would this do today" previews. */
export class AutomationService {
  constructor(
    private readonly prisma: Prisma,
    private readonly engine: AutomationEngine,
    private readonly standards: StandardsService,
    private readonly finops: FinopsService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<AutomationRuleDto[]> {
    const rows = await this.prisma.automationRule.findMany({
      include: LAST_RUN,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toRuleDto);
  }

  async get(id: string): Promise<AutomationRuleDto> {
    const row = await this.prisma.automationRule.findUnique({ where: { id }, include: LAST_RUN });
    if (!row) throw AppError.notFound('Automation rule not found');
    return toRuleDto(row);
  }

  async create(input: AutomationRuleInput, actor: AuditActor | null): Promise<AutomationRuleDto> {
    const row = await this.prisma.automationRule.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        enabled: input.enabled,
        trigger: input.trigger,
        conditions: input.conditions as PrismaNS.InputJsonValue,
        actions: input.actions as unknown as PrismaNS.InputJsonValue,
        createdById: actor?.id ?? null,
        createdBy: actor?.name ?? null,
      },
      include: LAST_RUN,
    });
    await this.audit.record({
      action: 'automation.rule.create',
      entity: 'automationRule',
      entityId: row.id,
      actor,
      metadata: { name: row.name, trigger: row.trigger },
    });
    return toRuleDto(row);
  }

  async update(
    id: string,
    input: AutomationRuleInput,
    actor: AuditActor | null,
  ): Promise<AutomationRuleDto> {
    await this.get(id);
    const row = await this.prisma.automationRule.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description ?? null,
        enabled: input.enabled,
        trigger: input.trigger,
        conditions: input.conditions as PrismaNS.InputJsonValue,
        actions: input.actions as unknown as PrismaNS.InputJsonValue,
      },
      include: LAST_RUN,
    });
    await this.audit.record({
      action: 'automation.rule.update',
      entity: 'automationRule',
      entityId: id,
      actor,
      metadata: { name: row.name, enabled: row.enabled },
    });
    return toRuleDto(row);
  }

  async setEnabled(
    id: string,
    enabled: boolean,
    actor: AuditActor | null,
  ): Promise<AutomationRuleDto> {
    await this.get(id);
    const row = await this.prisma.automationRule.update({
      where: { id },
      data: { enabled },
      include: LAST_RUN,
    });
    await this.audit.record({
      action: enabled ? 'automation.rule.enable' : 'automation.rule.disable',
      entity: 'automationRule',
      entityId: id,
      actor,
      metadata: { name: row.name },
    });
    return toRuleDto(row);
  }

  async remove(id: string, actor: AuditActor | null): Promise<void> {
    const rule = await this.get(id);
    await this.prisma.automationRule.delete({ where: { id } });
    await this.audit.record({
      action: 'automation.rule.delete',
      entity: 'automationRule',
      entityId: id,
      actor,
      metadata: { name: rule.name },
    });
  }

  async runs(q: AutomationRunsQuery): Promise<AutomationRunDto[]> {
    const rows = await this.prisma.automationRun.findMany({
      where: q.ruleId ? { ruleId: q.ruleId } : {},
      include: { rule: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    return rows.map((r) => {
      const d = (r.detail ?? {}) as RunDetail;
      return {
        id: r.id,
        ruleId: r.ruleId,
        ruleName: r.rule.name,
        trigger: r.trigger,
        status: r.status,
        matched: d.matched ?? 0,
        truncated: Boolean(d.truncated),
        matches: d.matches ?? [],
        actions: d.actions ?? [],
        error: r.error,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  /** Today's data for a trigger, as matches — with a sentence saying what that data is. */
  private async currentMatches(
    trigger: AutomationTrigger,
    conditions: AutomationRuleInput['conditions'],
  ): Promise<{ basis: string; matches: AutomationMatchDto[] }> {
    switch (trigger) {
      case 'compliance.new-failures': {
        const summary = await this.standards.summary();
        const failing = summary.standards
          .flatMap((s) => s.rules)
          .filter((r) => r.enabled && r.failed > 0)
          .map((r) => ({
            ruleId: r.id,
            ruleName: r.name,
            severity: r.severity,
            resourceIds: [],
            count: r.failed,
          }));
        return {
          basis:
            'Every rule failing now. Live, the rule fires only for resources that newly start failing after an evaluation.',
          matches: complianceMatches(failing, conditions, false),
        };
      }
      case 'cost.anomaly': {
        const a = await this.finops.costAnomalies({});
        return {
          basis: a.latestDate
            ? `Cost anomalies on ${a.latestDate}, the latest day of cost data.`
            : 'There is no cost data yet.',
          matches: anomalyMatches(a.anomalies, conditions, a.currency),
        };
      }
      case 'budget.threshold': {
        const [budgets, currency] = await Promise.all([
          this.finops.budgetAlerts(),
          this.finops.reportingCurrency(),
        ]);
        return {
          basis: 'Budgets as of the latest cost data.',
          matches: budgetMatches(
            budgets,
            conditions,
            currency,
            new Date().toISOString().slice(0, 7),
          ),
        };
      }
      case 'drift.detected': {
        const run = await this.prisma.syncRun.findFirst({
          where: { status: 'completed', changes: { gt: 0 } },
          orderBy: { finishedAt: 'desc' },
          select: { id: true, finishedAt: true },
        });
        if (!run) return { basis: 'No sync has found changes yet.', matches: [] };
        const changes = await this.prisma.changeEvent.findMany({
          where: { syncRunId: run.id },
          select: { resourceId: true, field: true },
        });
        return {
          basis: `The most recent sync that found changes (${run.finishedAt?.toISOString().slice(0, 16).replace('T', ' ')} UTC).`,
          matches: driftMatches(run.id, changes, conditions),
        };
      }
      case 'sync.failed': {
        const run = await this.prisma.syncRun.findFirst({
          where: { status: 'failed' },
          orderBy: { createdAt: 'desc' },
          select: { id: true, error: true, createdAt: true },
        });
        return run
          ? {
              basis: `The most recent failed sync (${run.createdAt.toISOString().slice(0, 10)}).`,
              matches: [syncFailedMatch(run.id, run.error ?? 'unknown error')],
            }
          : { basis: 'No sync has failed.', matches: [] };
      }
      case 'sync.unreachable': {
        const run = await this.prisma.syncRun.findFirst({
          where: { status: 'completed' },
          orderBy: { finishedAt: 'desc' },
          select: { id: true, summary: true },
        });
        return {
          basis: 'The most recent completed sync.',
          matches: run
            ? unreachableMatches(run.id, (run.summary as SyncSummary | null)?.accountErrors ?? [])
            : [],
        };
      }
      case 'remediation.failed': {
        const run = await this.prisma.remediationRun.findFirst({
          where: { status: { in: ['failed', 'partial'] } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, title: true, status: true, summary: true },
        });
        return run
          ? {
              basis: 'The most recent remediation that failed.',
              matches: [
                remediationFailedMatch(
                  run.id,
                  run.title,
                  run.status,
                  run.summary as { total: number; failed: number; verified: number } | null,
                ),
              ],
            }
          : { basis: 'No remediation has failed.', matches: [] };
      }
    }
  }

  private describe(action: AutomationAction, count: number, openAlready: number): string {
    if (action.type === 'notify') {
      const who = action.audience
        ? `people who can “${PERMISSIONS[action.audience].toLowerCase()}”`
        : 'everyone';
      return `Notify ${who} — ${Math.min(count, 10)} notification${count === 1 ? '' : 's'}${count > 10 ? ' plus a summary' : ''} (${action.severity}).`;
    }
    const fresh = count - openAlready;
    return `Create ${fresh} ${action.workType} work item${fresh === 1 ? '' : 's'} (priority ${action.priority}${action.assignee ? `, assigned to ${action.assignee}` : ''})${openAlready ? ` — ${openAlready} already have an open one` : ''}.`;
  }

  /** What a rule (saved or draft) would act on with today's data. Nothing is done. */
  async preview(input: AutomationRuleInput, ruleId?: string): Promise<AutomationPreviewDto> {
    const { basis, matches } = await this.currentMatches(input.trigger, input.conditions);
    const acted = matches.slice(0, MAX_MATCHES_PER_RUN);
    const open = ruleId
      ? await this.prisma.workItem.count({
          where: {
            sourceType: 'automation',
            sourceId: { in: acted.map((m) => `${ruleId}:${m.key}`) },
            state: { not: 'done' },
          },
        })
      : 0;
    return {
      basis: `${AUTOMATION_TRIGGER_INFO[input.trigger].label}: ${basis}`,
      matches: acted,
      total: matches.length,
      wouldDo: acted.length ? input.actions.map((a) => this.describe(a, acted.length, open)) : [],
    };
  }

  /** Run a saved rule now against today's data (to try it out). Recorded like any run. */
  async runNow(id: string, actor: AuditActor | null): Promise<AutomationRunDto> {
    const row = await this.prisma.automationRule.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Automation rule not found');
    const parsed = parseRule(row);
    if (!parsed)
      throw AppError.badRequest('The rule’s settings are invalid — edit and save it again.');
    const { matches } = await this.currentMatches(
      row.trigger as AutomationTrigger,
      parsed.conditions,
    );
    const runId = await this.engine.execute(
      row,
      row.trigger,
      parsed.actions,
      matches,
      `manual:${Date.now()}`,
      actor?.name ?? null,
    );
    await this.audit.record({
      action: 'automation.rule.run',
      entity: 'automationRule',
      entityId: id,
      actor,
      metadata: { name: row.name, matched: matches.length },
    });
    const run = (await this.runs({ ruleId: id, limit: 5 })).find((r) => r.id === runId);
    if (!run) throw new Error(`automation run ${runId} was not recorded`);
    return run;
  }
}
