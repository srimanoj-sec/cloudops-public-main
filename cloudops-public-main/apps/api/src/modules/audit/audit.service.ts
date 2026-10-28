import type { Request } from 'express';
import type { Prisma as PrismaNS } from '@prisma/client';
import {
  paginate,
  type AuditActorDto,
  type AuditLogDto,
  type AuditQuery,
  type Paginated,
} from '@cloudops/core';
import type { Logger } from '@cloudops/kernel';
import type { Prisma } from '../../infra/prisma.js';
import { currentContext } from '../../infra/request-context.js';
import { redact } from '../../infra/logger.js';

/** Most rows one CSV export returns. */
export const AUDIT_EXPORT_LIMIT = 10_000;

/** Who performed an action. `null` = the platform itself (sync, scheduler). */
export interface AuditActor {
  id?: string | null;
  name?: string | null;
}

export interface AuditEntry {
  /** Dotted verb, e.g. `auth.login.failed`, `provider.account.delete`. */
  action: string;
  /** Kind of thing acted on, e.g. `user`, `resource`, `standard`. */
  entity: string;
  entityId?: string | null;
  /** Non-secret context. Secret-looking keys are scrubbed defensively. */
  metadata?: Record<string, unknown>;
  actor?: AuditActor | null;
}

/** The authenticated caller as an audit actor. */
export function actorOf(req: Request): AuditActor | null {
  if (!req.user) return null;
  return { id: req.user.id, name: req.user.name || req.user.email };
}

/**
 * Append-only audit trail: who did what, when, to which resource, from where.
 * `record` never throws — failing to audit must not fail (or roll back) the
 * operation being audited; the failure is logged instead.
 */
export class AuditService {
  constructor(
    private readonly prisma: Prisma,
    private readonly logger: Logger,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const ctx = currentContext();
    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId ?? null,
          actor: entry.actor?.name ?? null,
          actorId: entry.actor?.id ?? null,
          metadata: entry.metadata
            ? (redact(entry.metadata) as PrismaNS.InputJsonValue)
            : undefined,
          ip: ctx?.ip ?? null,
          requestId: ctx?.requestId ?? null,
        },
      });
    } catch (err) {
      this.logger.error('failed to write audit entry', {
        action: entry.action,
        entity: entry.entity,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private whereFor(q: Omit<AuditQuery, 'page' | 'pageSize'>): PrismaNS.AuditLogWhereInput {
    const where: PrismaNS.AuditLogWhereInput = {};
    if (q.action) where.action = { startsWith: q.action };
    if (q.entity) where.entity = q.entity;
    if (q.entityId) where.entityId = q.entityId;
    if (q.actorId) where.actorId = q.actorId;
    if (q.requestId) where.requestId = q.requestId;
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }
    if (q.search) {
      where.OR = [
        { actor: { contains: q.search, mode: 'insensitive' } },
        { action: { contains: q.search, mode: 'insensitive' } },
        { entity: { contains: q.search, mode: 'insensitive' } },
        { entityId: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  async list(q: AuditQuery): Promise<Paginated<AuditLogDto>> {
    const where = this.whereFor(q);
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginate(
      rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        actorId: r.actorId,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        metadata: r.metadata,
        ip: r.ip,
        requestId: r.requestId,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      q.page,
      q.pageSize,
    );
  }

  /** People who appear in the log, most active first (for the actor filter). */
  async actors(): Promise<AuditActorDto[]> {
    const rows = await this.prisma.auditLog.groupBy({
      by: ['actorId', 'actor'],
      where: { actorId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { actorId: 'desc' } },
      take: 200,
    });
    // One entry per user id (a rename leaves several display names): keep the most used.
    const byId = new Map<string, AuditActorDto>();
    for (const r of rows) {
      const prev = byId.get(r.actorId!);
      if (prev) prev.events += r._count._all;
      else byId.set(r.actorId!, { actorId: r.actorId!, actor: r.actor, events: r._count._all });
    }
    return [...byId.values()].sort((a, b) => b.events - a.events);
  }

  /**
   * The filtered log as CSV (newest first, capped at {@link AUDIT_EXPORT_LIMIT}
   * rows). Cells that a spreadsheet would run as a formula are neutralised.
   */
  async exportCsv(
    q: Omit<AuditQuery, 'page' | 'pageSize'>,
  ): Promise<{ csv: string; rows: number; truncated: boolean }> {
    const rows = await this.prisma.auditLog.findMany({
      where: this.whereFor(q),
      orderBy: { createdAt: 'desc' },
      take: AUDIT_EXPORT_LIMIT + 1,
    });
    const truncated = rows.length > AUDIT_EXPORT_LIMIT;
    const cell = (v: unknown) => {
      let s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      'time',
      'actor',
      'actor_id',
      'action',
      'entity',
      'entity_id',
      'ip',
      'request_id',
      'details',
    ];
    const lines = rows
      .slice(0, AUDIT_EXPORT_LIMIT)
      .map((r) =>
        [
          r.createdAt.toISOString(),
          r.actor,
          r.actorId,
          r.action,
          r.entity,
          r.entityId,
          r.ip,
          r.requestId,
          r.metadata,
        ]
          .map(cell)
          .join(','),
      );
    return { csv: [header.join(','), ...lines].join('\r\n'), rows: lines.length, truncated };
  }

  /** Distinct action names (for the audit page's filter). */
  async actions(): Promise<string[]> {
    const rows = await this.prisma.auditLog.findMany({
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
    });
    return rows.map((r) => r.action);
  }
}
