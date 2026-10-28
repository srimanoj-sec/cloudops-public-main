import type { Prisma as PrismaNS } from '@prisma/client';
import {
  paginate,
  resourceQuerySchema,
  setResourceTagsSchema,
  type CreateRemediationRequest,
  type DecideRemediationRequest,
  type Paginated,
  type RemediationActionDto,
  type RemediationPlanDto,
  type RemediationPlanTargetDto,
  type RemediationQuery,
  type RemediationRunDetailDto,
  type RemediationRunDto,
  type RemediationStatus,
  type RemediationTargeting,
  type RemediationTargetStatus,
} from '@cloudops/core';
import type { EventBus, Logger } from '@cloudops/kernel';
import type { ProviderRegistry } from '@cloudops/provider-sdk';
import { AppError } from '../../http/errors.js';
import { assertQueueAvailable, withQueueTimeout } from '../../infra/bullmq.js';
import type { Prisma } from '../../infra/prisma.js';
import { remediationQueue } from '../../infra/queue.js';
import type { AuditService } from '../audit/audit.service.js';
import type { InventoryRepository } from '../inventory/inventory.repository.js';
import {
  ACTIONS,
  ACTION_INDEX,
  missingActionParams,
  type ActionDef,
  type PlanResource,
} from './remediation.catalog.js';

/** The caller, as far as remediation cares. */
export interface Actor {
  id: string;
  name: string;
  permissions: string[];
}

export interface RemediationDeps {
  prisma: Prisma;
  registry: ProviderRegistry;
  audit: AuditService;
  events: EventBus;
  logger: Logger;
  /** AZURE_ALLOW_WRITE — nothing is executed when off. */
  writeEnabled: boolean;
  /** Let a requester approve their own medium/high-risk change (default: no — four eyes). */
  allowSelfApproval: boolean;
  ownerTag: string;
  /** Resolves inventory filters to resources (bulk targeting). */
  inventory: InventoryRepository;
  providerKey?: string;
}

const MAX_TARGETS = 500;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type RunRow = PrismaNS.RemediationRunGetPayload<{
  include: { _count: { select: { targets: true } } };
}>;

function toRunDto(r: RunRow): RemediationRunDto {
  return {
    id: r.id,
    actionKey: r.actionKey,
    title: r.title,
    risk: r.risk as RemediationRunDto['risk'],
    status: r.status as RemediationStatus,
    params: (r.params as Record<string, unknown> | null) ?? null,
    source: r.sourceType && r.sourceId ? { type: r.sourceType, id: r.sourceId } : null,
    workItemId: r.workItemId,
    requestedBy: r.requestedBy,
    requestedById: r.requestedById,
    approvedBy: r.approvedBy,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    executedBy: r.executedBy,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    summary: (r.summary as RemediationRunDto['summary']) ?? null,
    error: r.error,
    targetCount: r._count.targets,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Remediation workflow: plan (dry run from the cached configuration) →
 * request → approve (medium/high risk, by someone else) → execute (background
 * job) → verify → record. Every transition is audited and emitted as an event.
 */
export class RemediationService {
  constructor(private readonly d: RemediationDeps) {}

  private get providerKey(): string {
    return this.d.providerKey ?? 'azure';
  }

  /** Can this action run here, and if not, why. */
  private availability(def: ActionDef): { available: boolean; reason: string | null } {
    if (!this.d.writeEnabled)
      return {
        available: false,
        reason: 'Write-back to the cloud is turned off (AZURE_ALLOW_WRITE=false).',
      };
    if (!this.d.registry.has(this.providerKey))
      return { available: false, reason: 'No cloud provider is registered.' };
    const provider = this.d.registry.get(this.providerKey);
    if (def.mode === 'provider' && !provider.executeAction)
      return { available: false, reason: `${provider.displayName} can’t run actions.` };
    if (def.mode === 'tags' && !provider.updateResourceTags)
      return { available: false, reason: `${provider.displayName} can’t write tags.` };
    return { available: true, reason: null };
  }

  private toActionDto(def: ActionDef): RemediationActionDto {
    const a = this.availability(def);
    return {
      key: def.key,
      title: def.title,
      description: def.description,
      change: def.change,
      risk: def.risk,
      riskReason: def.riskReason,
      fixesRules: def.fixesRules,
      appliesTo: def.appliesTo,
      types: def.types,
      params: def.params,
      reversible: def.reversible,
      rollback: def.rollback,
      disruption: def.disruption,
      requiresApproval: def.risk !== 'low',
      available: a.available,
      unavailableReason: a.reason,
    };
  }

  actions(): RemediationActionDto[] {
    return ACTIONS.map((a) => this.toActionDto(a));
  }

  private def(key: string): ActionDef {
    const def = ACTION_INDEX.get(key);
    if (!def) throw AppError.badRequest(`Unknown action "${key}".`);
    return def;
  }

  // ── Planning ───────────────────────────────────────────────────────

  /** Resources an action targets: explicit ids, or everything failing a rule. */
  private async resolveTargets(def: ActionDef, input: RemediationTargeting) {
    let ids = input.resourceIds ?? [];
    let rule: {
      id: string;
      template: string | null;
      name: string | null;
      description: string;
    } | null = null;
    if (input.ruleId) {
      rule = await this.d.prisma.standardRule.findUnique({
        where: { id: input.ruleId },
        select: { id: true, template: true, name: true, description: true },
      });
      if (!rule) throw AppError.notFound('Rule not found');
      if (!rule.template || !def.fixesRules.includes(rule.template)) {
        throw AppError.badRequest(`“${def.title}” doesn’t fix “${rule.name ?? rule.description}”.`);
      }
      if (!ids.length) {
        const failing = await this.d.prisma.complianceResult.findMany({
          where: { ruleId: rule.id, scopeType: 'resource', passed: false, exempt: false },
          select: { scopeId: true },
          take: MAX_TARGETS,
        });
        ids = failing.map((f) => f.scopeId);
      }
    }
    if (!ids.length && !input.ruleId && input.filter) {
      const q = resourceQuerySchema.parse({
        ...input.filter,
        page: 1,
        pageSize: MAX_TARGETS,
        state: 'active',
      });
      const where = await this.d.inventory.whereFor(q);
      ids = (
        await this.d.prisma.resource.findMany({ where, select: { id: true }, take: MAX_TARGETS })
      ).map((r) => r.id);
    }
    const rows = await this.d.prisma.resource.findMany({
      where: { id: { in: [...new Set(ids)].slice(0, MAX_TARGETS) } },
      select: {
        id: true,
        externalId: true,
        name: true,
        type: true,
        state: true,
        owner: true,
        tags: true,
        platformTags: true,
        properties: true,
        resourceGroup: { select: { name: true } },
        subscription: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    });
    return { rule, rows };
  }

  private planResource(
    r: Awaited<ReturnType<RemediationService['resolveTargets']>>['rows'][number],
  ): PlanResource {
    return {
      id: r.id,
      externalId: r.externalId,
      name: r.name,
      type: r.type.toLowerCase(),
      state: r.state,
      owner: r.owner,
      tags: {
        ...((r.tags as Record<string, string>) ?? {}),
        ...((r.platformTags as Record<string, string> | null) ?? {}),
      },
      properties: (r.properties as Record<string, unknown>) ?? {},
    };
  }

  /** The exact call a target would get. */
  private preview(def: ActionDef, r: PlanResource, params: Record<string, unknown>): string | null {
    try {
      if (def.mode === 'tags') {
        const tags = def.tags(params, this.d.ownerTag);
        return `az tag update --resource-id ${r.externalId} --operation Merge --tags ${Object.entries(
          tags,
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}`;
      }
      const provider = this.d.registry.get(this.providerKey);
      return provider.previewAction?.(def.build(r, params)) ?? null;
    } catch (err) {
      return `(refused: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  async plan(input: RemediationTargeting): Promise<RemediationPlanDto> {
    const def = this.def(input.actionKey);
    const params = input.params ?? {};
    const invalid = def.validate?.(params);
    if (invalid) throw AppError.badRequest(invalid);
    const { rows } = await this.resolveTargets(def, input);
    const targets: RemediationPlanTargetDto[] = rows.map((row) => {
      const r = this.planResource(row);
      const base = {
        resourceId: r.id,
        name: r.name,
        type: row.type,
        resourceGroup: row.resourceGroup?.name ?? null,
        subscription: row.subscription?.name ?? null,
        desired: def.desired(params),
      };
      if (r.state !== 'active')
        return {
          ...base,
          current: 'deleted',
          command: null,
          skip: 'no longer exists in the provider',
        };
      if (def.types && !def.types.includes(r.type))
        return { ...base, current: '—', command: null, skip: `not one of: ${def.appliesTo}` };
      const cur = def.current(r, params);
      return {
        ...base,
        current: cur.text,
        command: cur.skip ? null : this.preview(def, r, params),
        skip: cur.skip,
      };
    });

    const action = this.toActionDto(def);
    const willChange = targets.filter((t) => !t.skip).length;
    const warnings: string[] = [];
    if (!action.available) warnings.push(`Can’t run here: ${action.unavailableReason}`);
    if (def.risk === 'high') warnings.push(`High risk — ${def.riskReason}`);
    if (!def.reversible) warnings.push(`Can’t be undone. ${def.rollback}`);
    const prod = rows.filter((row) => {
      const tags = this.planResource(row).tags;
      const env =
        Object.entries(tags).find(([k]) => ['env', 'environment'].includes(k.toLowerCase()))?.[1] ??
        '';
      return /^(prod|production|prd|live)([-_ ].*)?$/i.test(env);
    }).length;
    if (prod) warnings.push(`${plural(prod, 'target')} tagged production.`);
    if (targets.some((t) => t.skip?.includes('last sync')))
      warnings.push(
        '“Current” values come from the last sync; resources already fixed in the cloud are skipped at run time.',
      );
    const missing = missingActionParams(def, params);
    if (missing.length) warnings.push(`Fill in: ${missing.join(', ')}.`);

    return {
      action,
      targets,
      willChange,
      skipped: targets.length - willChange,
      requiresApproval: action.requiresApproval,
      warnings,
    };
  }

  // ── Workflow ───────────────────────────────────────────────────────

  private async load(id: string) {
    const run = await this.d.prisma.remediationRun.findUnique({
      where: { id },
      include: {
        _count: { select: { targets: true } },
        targets: { orderBy: { resourceName: 'asc' } },
      },
    });
    if (!run) throw AppError.notFound('Remediation not found');
    return run;
  }

  private async record(
    action: string,
    runId: string,
    actor: Actor | null,
    metadata: Record<string, unknown>,
    workItemId?: string | null,
  ) {
    await this.d.audit.record({
      action,
      entity: 'remediationRun',
      entityId: runId,
      actor: actor && { id: actor.id, name: actor.name },
      metadata,
    });
    if (workItemId) {
      await this.d.audit.record({
        action,
        entity: 'workItem',
        entityId: workItemId,
        actor: actor && { id: actor.id, name: actor.name },
        metadata: { ...metadata, runId },
      });
    }
  }

  async request(input: CreateRemediationRequest, actor: Actor): Promise<RemediationRunDetailDto> {
    const def = this.def(input.actionKey);
    const params = input.params ?? {};
    const missing = missingActionParams(def, params);
    if (missing.length) throw AppError.badRequest(`Fill in: ${missing.join(', ')}.`);
    if (def.mode === 'tags') {
      const parsed = setResourceTagsSchema.safeParse({ tags: def.tags(params, this.d.ownerTag) });
      if (!parsed.success)
        throw AppError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid tag');
    }
    const plan = await this.plan(input);
    if (plan.willChange === 0)
      throw AppError.badRequest(
        'Nothing to change — every target is already compliant or can’t be acted on.',
      );
    if (
      input.workItemId &&
      !(await this.d.prisma.workItem.findUnique({
        where: { id: input.workItemId },
        select: { id: true },
      }))
    ) {
      throw AppError.notFound('Work item not found');
    }

    const needsApproval = def.risk !== 'low';
    const rule = input.ruleId
      ? await this.d.prisma.standardRule.findUnique({
          where: { id: input.ruleId },
          select: { name: true, description: true },
        })
      : null;
    const source =
      input.source ??
      (input.ruleId
        ? { type: 'rule', id: input.ruleId, label: rule?.name ?? rule?.description }
        : undefined);
    const run = await this.d.prisma.remediationRun.create({
      data: {
        actionKey: def.key,
        title: `${def.title} — ${plural(plan.willChange, 'resource')}`,
        providerKey: this.providerKey,
        risk: def.risk,
        status: needsApproval ? 'pending_approval' : 'approved',
        params: params as PrismaNS.InputJsonValue,
        sourceType: source?.type ?? null,
        sourceId: source?.id ?? null,
        workItemId: input.workItemId ?? null,
        requestedById: actor.id,
        requestedBy: actor.name,
        log: [
          {
            at: new Date().toISOString(),
            level: 'info',
            message: `Requested by ${actor.name}${input.note ? `: ${input.note}` : ''}`,
          },
        ],
        targets: {
          create: plan.targets.map((t) => ({
            resourceId: t.resourceId,
            resourceName: t.name,
            externalId: '',
            status: t.skip ? 'skipped' : 'pending',
            before: t.current,
            command: t.command,
            message: t.skip,
          })),
        },
      },
    });
    // External ids for the record (kept even if the resource row goes away).
    await this.d.prisma.$executeRaw`
      UPDATE "RemediationTarget" t SET "externalId" = r."externalId" FROM "Resource" r
      WHERE t."runId" = ${run.id} AND r.id = t."resourceId"`;

    await this.record(
      'remediation.request',
      run.id,
      actor,
      {
        action: def.key,
        risk: def.risk,
        willChange: plan.willChange,
        skipped: plan.skipped,
        params,
        note: input.note ?? null,
        source: source ?? null,
        summary: `requested “${def.title}” on ${plural(plan.willChange, 'resource')}`,
      },
      input.workItemId,
    );
    await this.d.events.emit('remediation.requested', {
      runId: run.id,
      title: run.title,
      risk: def.risk,
      requestedBy: actor.name,
      requestedById: actor.id,
      needsApproval,
      targets: plan.willChange,
    });

    if (input.executeNow && !needsApproval && actor.permissions.includes('remediation.execute')) {
      return this.execute(run.id, actor);
    }
    return this.detail(run.id, actor);
  }

  async decide(
    id: string,
    input: DecideRemediationRequest,
    actor: Actor,
  ): Promise<RemediationRunDetailDto> {
    const run = await this.load(id);
    if (run.status !== 'pending_approval')
      throw AppError.conflict(
        `This remediation is ${run.status.replace('_', ' ')}, not waiting for approval.`,
      );
    if (run.requestedById === actor.id && !this.d.allowSelfApproval && input.approve) {
      throw AppError.forbidden(
        'Someone other than the requester has to approve a medium- or high-risk change.',
      );
    }
    const status: RemediationStatus = input.approve ? 'approved' : 'rejected';
    await this.d.prisma.remediationRun.update({
      where: { id },
      data: {
        status,
        approvedById: actor.id,
        approvedBy: actor.name,
        decidedAt: new Date(),
        decisionNote: input.note ?? null,
        log: [
          ...((run.log as unknown[]) ?? []),
          {
            at: new Date().toISOString(),
            level: 'info',
            message: `${input.approve ? 'Approved' : 'Rejected'} by ${actor.name}${input.note ? `: ${input.note}` : ''}`,
          },
        ] as PrismaNS.InputJsonValue,
      },
    });
    await this.record(
      input.approve ? 'remediation.approve' : 'remediation.reject',
      id,
      actor,
      {
        note: input.note ?? null,
        summary: `${input.approve ? 'approved' : 'rejected'} the remediation`,
      },
      run.workItemId,
    );
    await this.d.events.emit('remediation.decided', {
      runId: id,
      title: run.title,
      approved: input.approve,
      decidedBy: actor.name,
      requestedById: run.requestedById,
    });
    return this.detail(id, actor);
  }

  async execute(id: string, actor: Actor): Promise<RemediationRunDetailDto> {
    const run = await this.load(id);
    if (run.status !== 'approved') {
      throw AppError.conflict(
        run.status === 'pending_approval'
          ? 'This change needs approval before it can run.'
          : `This remediation is ${run.status.replace('_', ' ')}.`,
      );
    }
    const def = this.def(run.actionKey);
    const a = this.availability(def);
    if (!a.available) throw AppError.forbidden(a.reason ?? 'This action can’t run here.');
    await assertQueueAvailable();
    await this.d.prisma.remediationRun.update({
      where: { id },
      data: {
        status: 'queued',
        executedById: actor.id,
        executedBy: actor.name,
        log: [
          ...((run.log as unknown[]) ?? []),
          {
            at: new Date().toISOString(),
            level: 'info',
            message: `Queued for execution by ${actor.name}`,
          },
        ] as PrismaNS.InputJsonValue,
      },
    });
    try {
      await withQueueTimeout(
        remediationQueue.add(
          'remediation',
          { runId: id },
          { jobId: id, removeOnComplete: 200, removeOnFail: 200, attempts: 1 },
        ),
      );
    } catch (err) {
      await this.d.prisma.remediationRun.update({ where: { id }, data: { status: 'approved' } });
      throw err;
    }
    await this.record(
      'remediation.execute',
      id,
      actor,
      { summary: 'started the remediation' },
      run.workItemId,
    );
    return this.detail(id, actor);
  }

  async cancel(id: string, actor: Actor): Promise<RemediationRunDetailDto> {
    const run = await this.load(id);
    if (!['pending_approval', 'approved', 'queued'].includes(run.status)) {
      throw AppError.conflict(`A ${run.status.replace('_', ' ')} remediation can’t be cancelled.`);
    }
    if (run.requestedById !== actor.id && !actor.permissions.includes('remediation.approve')) {
      throw AppError.forbidden('Only the requester or an approver can cancel this.');
    }
    if (run.status === 'queued') {
      const job = await withQueueTimeout(remediationQueue.getJob(id)).catch(() => undefined);
      const state = await job?.getState().catch(() => undefined);
      if (state === 'active')
        throw AppError.conflict('It has started running and can’t be cancelled now.');
      await job?.remove().catch(() => undefined);
    }
    await this.d.prisma.remediationRun.update({
      where: { id },
      data: {
        status: 'cancelled',
        finishedAt: new Date(),
        log: [
          ...((run.log as unknown[]) ?? []),
          { at: new Date().toISOString(), level: 'info', message: `Cancelled by ${actor.name}` },
        ] as PrismaNS.InputJsonValue,
      },
    });
    await this.record(
      'remediation.cancel',
      id,
      actor,
      { summary: 'cancelled the remediation' },
      run.workItemId,
    );
    return this.detail(id, actor);
  }

  // ── Read models ────────────────────────────────────────────────────

  async list(q: RemediationQuery): Promise<Paginated<RemediationRunDto>> {
    const where: PrismaNS.RemediationRunWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.sourceType) where.sourceType = q.sourceType;
    if (q.sourceId) where.sourceId = q.sourceId;
    if (q.resourceId) where.targets = { some: { resourceId: q.resourceId } };
    const [rows, total] = await Promise.all([
      this.d.prisma.remediationRun.findMany({
        where,
        include: { _count: { select: { targets: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.d.prisma.remediationRun.count({ where }),
    ]);
    return paginate(rows.map(toRunDto), total, q.page, q.pageSize);
  }

  async detail(id: string, actor: Actor): Promise<RemediationRunDetailDto> {
    const run = await this.load(id);
    const def = ACTION_INDEX.get(run.actionKey);
    const can = (p: string) => actor.permissions.includes(p);
    const pending = run.status === 'pending_approval';
    const self = run.requestedById === actor.id && !this.d.allowSelfApproval;
    const available = def
      ? this.availability(def)
      : { available: false, reason: 'This action no longer exists.' };
    let reason: string | null = null;
    if (pending && self) reason = 'Waiting for someone else to approve — you requested it.';
    else if (pending && !can('remediation.approve')) reason = 'Waiting for an approver.';
    else if (run.status === 'approved' && !can('remediation.execute'))
      reason = 'Approved — someone who can run remediations has to start it.';
    else if (run.status === 'approved' && !available.available) reason = available.reason;
    return {
      ...toRunDto(run),
      source: run.sourceType && run.sourceId ? { type: run.sourceType, id: run.sourceId } : null,
      targets: run.targets.map((t) => ({
        id: t.id,
        resourceId: t.resourceId,
        resourceName: t.resourceName,
        externalId: t.externalId,
        status: t.status as RemediationTargetStatus,
        before: t.before,
        after: t.after,
        command: t.command,
        message: t.message,
        startedAt: t.startedAt?.toISOString() ?? null,
        finishedAt: t.finishedAt?.toISOString() ?? null,
      })),
      log: ((run.log as unknown as RemediationRunDetailDto['log']) ?? []).slice(-500),
      action: def ? this.toActionDto(def) : null,
      allowed: {
        approve: pending && can('remediation.approve') && !self,
        reject: pending && can('remediation.approve'),
        execute: run.status === 'approved' && can('remediation.execute') && available.available,
        cancel:
          ['pending_approval', 'approved', 'queued'].includes(run.status) &&
          (run.requestedById === actor.id || can('remediation.approve')),
        reason,
      },
    };
  }

  /** Crash recovery: runs left queued/running with no live job are failed (maintenance). */
  async reconcileInterrupted(graceMs = 10 * 60_000): Promise<number> {
    const stale = await this.d.prisma.remediationRun.findMany({
      where: {
        status: { in: ['queued', 'running'] },
        updatedAt: { lt: new Date(Date.now() - graceMs) },
      },
      select: { id: true },
    });
    let fixed = 0;
    for (const r of stale) {
      const job = await withQueueTimeout(remediationQueue.getJob(r.id)).catch(() => undefined);
      const state = await job?.getState().catch(() => undefined);
      if (state && ['active', 'waiting', 'delayed'].includes(state)) continue;
      await this.d.prisma.remediationRun.update({
        where: { id: r.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error:
            'Interrupted — the worker stopped before this run finished. Check each resource, then request it again.',
        },
      });
      fixed++;
    }
    if (fixed) this.d.logger.warn(`marked ${fixed} interrupted remediation run(s) as failed`);
    return fixed;
  }
}
