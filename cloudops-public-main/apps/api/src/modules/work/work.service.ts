import type { Prisma as PrismaNS } from '@prisma/client';
import type {
  CreateWorkItemInput,
  UpdateWorkItemRequest,
  WorkActivityDto,
  WorkCommentDto,
  WorkItemDetailDto,
  WorkItemDto,
  WorkItemQuery,
  WorkItemStateDto,
  WorkSummaryDto,
} from '@cloudops/core';
import type { EventBus } from '@cloudops/kernel';
import { AppError } from '../../http/errors.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import type { WorkItemRow, WorkRepository } from './work.repository.js';

function key(scopeType: string, scopeId: string): string {
  return `${scopeType}:${scopeId}`;
}

/** Advance a date by the recurrence cadence (for the next review occurrence). */
function advanceDate(base: Date, recurrence: string): Date {
  const d = new Date(base);
  if (recurrence === 'weekly') d.setDate(d.getDate() + 7);
  else if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (recurrence === 'quarterly') d.setMonth(d.getMonth() + 3);
  return d;
}

const STATE_LABEL: Record<string, string> = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };

function buildWhere(q: Partial<WorkItemQuery>): PrismaNS.WorkItemWhereInput {
  const where: PrismaNS.WorkItemWhereInput = {};
  if (q.state) where.state = q.state;
  if (q.type) where.type = q.type;
  if (q.assignee) where.assignee = q.assignee;
  if (q.scopeType && q.scopeId) where.links = { some: { scopeType: q.scopeType, scopeId: q.scopeId } };
  if (q.sourceType) where.sourceType = q.sourceType;
  if (q.sourceId) where.sourceId = q.sourceId;
  if (q.search) {
    where.OR = [
      { title: { contains: q.search, mode: 'insensitive' } },
      { description: { contains: q.search, mode: 'insensitive' } },
    ];
  }
  return where;
}

function toDto(row: WorkItemRow, names: Map<string, string | null>): WorkItemDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    type: row.type,
    state: row.state as WorkItemStateDto,
    priority: row.priority,
    effort: row.effort ?? null,
    dueDate: row.dueDate?.toISOString() ?? null,
    assignee: row.assignee ?? null,
    recurrence: row.recurrence ?? null,
    source: row.sourceType && row.sourceId ? { type: row.sourceType, id: row.sourceId, label: row.sourceLabel } : null,
    createdBy: row.createdBy ?? null,
    links: row.links.map((l) => ({
      id: l.id,
      scopeType: l.scopeType,
      scopeId: l.scopeId,
      scopeName: names.get(key(l.scopeType, l.scopeId)) ?? null,
    })),
    labels: row.labels.map((l) => ({ id: l.label.id, name: l.label.name, color: l.label.color })),
    commentCount: row._count.comments,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Human summary of one audit entry on a work item. */
export function describeActivity(action: string, metadata: unknown): string {
  const m = (metadata ?? {}) as Record<string, unknown>;
  if (action === 'work.item.create') {
    const source = m.source as { label?: string | null; type?: string } | undefined;
    return source ? `created from ${source.label ?? source.type}` : 'created this item';
  }
  if (action === 'work.item.comment') return 'commented';
  if (action === 'work.item.update') {
    const changes = (m.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
    const parts: string[] = [];
    for (const [field, c] of Object.entries(changes)) {
      if (field === 'state') parts.push(`moved from ${STATE_LABEL[String(c.from)] ?? c.from} to ${STATE_LABEL[String(c.to)] ?? c.to}`);
      else if (field === 'assignee') parts.push(c.to ? `assigned to ${c.to}` : 'unassigned it');
      else if (field === 'priority') parts.push(`changed priority P${c.from} → P${c.to}`);
      else if (field === 'dueDate') parts.push(c.to ? `set the due date to ${String(c.to).slice(0, 10)}` : 'cleared the due date');
      else if (field === 'title') parts.push('renamed it');
      else if (field === 'description') parts.push('edited the description');
      else parts.push(`changed ${field}`);
    }
    return parts.join(', ') || 'updated it';
  }
  if (action.startsWith('remediation.')) return String(m.summary ?? action);
  return action;
}

export class WorkService {
  constructor(
    private readonly repo: WorkRepository,
    private readonly audit?: AuditService,
    private readonly events?: EventBus,
  ) {}

  /** Resolve display names for a batch of links (one query per scope type). */
  private async resolveNames(links: { scopeType: string; scopeId: string }[]): Promise<Map<string, string | null>> {
    const byType = new Map<string, Set<string>>();
    for (const l of links) {
      if (!byType.has(l.scopeType)) byType.set(l.scopeType, new Set());
      byType.get(l.scopeType)!.add(l.scopeId);
    }
    const ids = (t: string) => [...(byType.get(t) ?? [])];
    const [tenants, subs, rgs, resources] = await Promise.all([
      this.repo.tenantsByIds(ids('organization')),
      this.repo.subscriptionsByIds(ids('subscription')),
      this.repo.resourceGroupsByIds(ids('resourceGroup')),
      this.repo.resourcesByIds(ids('resource')),
    ]);
    const name = new Map<string, string | null>();
    for (const t of tenants) name.set(key('organization', t.id), t.name);
    for (const s of subs) name.set(key('subscription', s.id), s.name);
    for (const rg of rgs) name.set(key('resourceGroup', rg.id), rg.name);
    for (const r of resources) name.set(key('resource', r.id), r.name);
    return name;
  }

  /** The where clause for a query, with organization scoping resolved in SQL. */
  private async scopedWhere(q: Partial<WorkItemQuery>): Promise<PrismaNS.WorkItemWhereInput> {
    const where = buildWhere(q);
    if (!q.tenantId) return where;
    const ids = await this.repo.itemIdsInTenant(q.tenantId);
    return { AND: [where, { id: { in: ids.length ? ids : ['__none__'] } }] };
  }

  async list(q: Partial<WorkItemQuery>): Promise<WorkItemDto[]> {
    const rows = await this.repo.listItems(await this.scopedWhere(q), q.limit ?? 500);
    const names = await this.resolveNames(rows.flatMap((r) => r.links));
    return rows.map((r) => toDto(r, names));
  }

  async detail(id: string): Promise<WorkItemDetailDto> {
    const row = await this.repo.getItem(id);
    if (!row) throw AppError.notFound('Work item not found');
    const [names, audit] = await Promise.all([this.resolveNames(row.links), this.repo.activity(id)]);
    const activity: WorkActivityDto[] = audit.map((a) => ({
      id: a.id,
      at: a.createdAt.toISOString(),
      actor: a.actor,
      action: a.action,
      summary: describeActivity(a.action, a.metadata),
    }));
    return {
      ...toDto(row, names),
      comments: row.comments.map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt.toISOString() })),
      activity,
    };
  }

  async create(input: CreateWorkItemInput, actor: AuditActor | null = null): Promise<WorkItemDto> {
    const links = new Map<string, { scopeType: string; scopeId: string }>();
    for (const s of [...(input.scope ? [input.scope] : []), ...(input.scopes ?? [])]) {
      links.set(key(s.scopeType, s.scopeId), { scopeType: s.scopeType, scopeId: s.scopeId });
    }
    const row = await this.repo.createItem(
      {
        title: input.title,
        description: input.description ?? null,
        type: input.type,
        state: input.state,
        priority: input.priority,
        effort: input.effort ?? null,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        assignee: input.assignee?.trim() || null,
        recurrence: input.recurrence ?? null,
        sourceType: input.source?.type ?? null,
        sourceId: input.source?.id ?? null,
        sourceLabel: input.source?.label ?? null,
        createdById: actor?.id ?? null,
        createdBy: actor?.name ?? null,
      },
      [...links.values()],
    );
    await this.audit?.record({
      action: 'work.item.create',
      entity: 'workItem',
      entityId: row.id,
      actor,
      metadata: {
        title: row.title,
        type: row.type,
        priority: row.priority,
        links: links.size,
        ...(input.source ? { source: input.source } : {}),
      },
    });
    if (row.assignee) {
      await this.events?.emit('work.assigned', { itemId: row.id, title: row.title, assignee: row.assignee, actor: actor?.name ?? null, actorId: actor?.id ?? null });
    }
    const names = await this.resolveNames(row.links);
    return toDto(row, names);
  }

  async update(id: string, input: UpdateWorkItemRequest, actor: AuditActor | null = null): Promise<WorkItemDto> {
    const existing = await this.repo.getItem(id);
    if (!existing) throw AppError.notFound('Work item not found');

    const data: PrismaNS.WorkItemUpdateInput = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const track = <K extends keyof typeof existing>(field: K & string, next: unknown, prev: unknown) => {
      const a = prev instanceof Date ? prev.toISOString() : (prev ?? null);
      const b = next instanceof Date ? next.toISOString() : (next ?? null);
      if (a !== b) changes[field] = { from: field === 'description' ? undefined : a, to: field === 'description' ? undefined : b };
    };
    if (input.title !== undefined) {
      data.title = input.title;
      track('title', input.title, existing.title);
    }
    if (input.description !== undefined) {
      data.description = input.description;
      track('description', input.description, existing.description);
    }
    if (input.type !== undefined) {
      data.type = input.type;
      track('type', input.type, existing.type);
    }
    if (input.state !== undefined) {
      data.state = input.state;
      track('state', input.state, existing.state);
    }
    if (input.priority !== undefined) {
      data.priority = input.priority;
      track('priority', input.priority, existing.priority);
    }
    if (input.effort !== undefined) {
      data.effort = input.effort;
      track('effort', input.effort, existing.effort);
    }
    if (input.dueDate !== undefined) {
      const due = input.dueDate ? new Date(input.dueDate) : null;
      data.dueDate = due;
      track('dueDate', due, existing.dueDate);
    }
    if (input.assignee !== undefined) {
      const assignee = input.assignee?.trim() || null;
      data.assignee = assignee;
      track('assignee', assignee, existing.assignee);
    }
    if (input.recurrence !== undefined) {
      data.recurrence = input.recurrence;
      track('recurrence', input.recurrence, existing.recurrence);
    }

    const row = await this.repo.updateItem(id, data);
    if (Object.keys(changes).length) {
      await this.audit?.record({
        action: 'work.item.update',
        entity: 'workItem',
        entityId: id,
        actor,
        metadata: { title: row.title, changes },
      });
    }
    if (changes.assignee && row.assignee) {
      await this.events?.emit('work.assigned', { itemId: id, title: row.title, assignee: row.assignee, actor: actor?.name ?? null, actorId: actor?.id ?? null });
    }

    // Recurring review: completing a recurring item materializes the next one.
    const completingNow = input.state === 'done' && existing.state !== 'done';
    if (completingNow && existing.recurrence) {
      const nextDue = advanceDate(existing.dueDate ?? new Date(), existing.recurrence);
      const next = await this.repo.createItem(
        {
          title: existing.title,
          description: existing.description,
          type: existing.type,
          state: 'todo',
          priority: existing.priority,
          effort: existing.effort,
          dueDate: nextDue,
          assignee: existing.assignee,
          recurrence: existing.recurrence,
          sourceType: existing.sourceType,
          sourceId: existing.sourceId,
          sourceLabel: existing.sourceLabel,
          createdById: actor?.id ?? null,
          createdBy: actor?.name ?? null,
        },
        existing.links.map((l) => ({ scopeType: l.scopeType, scopeId: l.scopeId })),
      );
      await this.audit?.record({
        action: 'work.item.create',
        entity: 'workItem',
        entityId: next.id,
        actor,
        metadata: { title: next.title, recurrence: existing.recurrence, previous: id },
      });
    }

    const names = await this.resolveNames(row.links);
    return toDto(row, names);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.repo.getItem(id);
    if (!existing) throw AppError.notFound('Work item not found');
    await this.repo.deleteItem(id);
  }

  async addComment(id: string, author: string, body: string, actor: AuditActor | null = null): Promise<WorkCommentDto> {
    const existing = await this.repo.getItem(id);
    if (!existing) throw AppError.notFound('Work item not found');
    const c = await this.repo.addComment(id, author, body);
    await this.audit?.record({
      action: 'work.item.comment',
      entity: 'workItem',
      entityId: id,
      actor,
      metadata: { title: existing.title, commentId: c.id },
    });
    if (body.includes('@')) {
      await this.events?.emit('work.mentioned', { itemId: id, title: existing.title, body, actor: actor?.name ?? null, actorId: actor?.id ?? null });
    }
    return { id: c.id, author: c.author, body: c.body, createdAt: c.createdAt.toISOString() };
  }

  async summary(q: Partial<WorkItemQuery>): Promise<WorkSummaryDto> {
    const where = await this.scopedWhere({ ...q, state: undefined });
    const [groups, overdue] = await Promise.all([this.repo.countByState(where), this.repo.countOverdue(where, new Date())]);
    const byState: Record<WorkItemStateDto, number> = { todo: 0, in_progress: 0, blocked: 0, done: 0 };
    for (const g of groups) byState[g.state as WorkItemStateDto] = g._count._all;
    const total = Object.values(byState).reduce((a, b) => a + b, 0);
    return { total, byState, overdue };
  }
}
