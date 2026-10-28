import type { Prisma as PrismaNS } from '@prisma/client';
import type {
  NotificationCategory,
  NotificationDto,
  NotificationListDto,
  NotificationQuery,
  NotificationSeverity,
  Permission,
} from '@cloudops/core';
import type { Logger } from '@cloudops/kernel';
import type { Prisma } from '../../infra/prisma.js';

export interface PublishInput {
  category: NotificationCategory;
  severity?: NotificationSeverity;
  title: string;
  body?: string | null;
  link?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Only users holding this permission see it. Omit for everyone. */
  audience?: Permission | null;
  /** Address it to one user instead of an audience. */
  userId?: string | null;
  /** One notification per condition — a repeat publish with the same key is ignored. */
  dedupeKey?: string | null;
  /** Who caused it: a broadcast isn't shown to them (they know — they did it). */
  actorId?: string | null;
}

/** Who is reading: enough to decide visibility and read state. */
export interface Reader {
  id: string;
  permissions: string[];
}

/** Notifications older than this are purged by housekeeping. */
export const NOTIFICATION_RETENTION_DAYS = 90;

const clip = (s: string | null | undefined, n: number) => (s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * In-app notifications. Broadcast notifications are stored once and filtered
 * per reader by permission; read state is a per-user watermark ("mark all
 * read") plus individual read receipts, so neither publishing nor "mark all
 * read" fans out rows per user. `publish` never throws — failing to notify must
 * not fail the operation being reported.
 */
export class NotificationService {
  constructor(
    private readonly prisma: Prisma,
    private readonly logger: Logger,
  ) {}

  async publish(input: PublishInput): Promise<void> {
    try {
      await this.prisma.notification.createMany({
        data: [
          {
            category: input.category,
            severity: input.severity ?? 'info',
            title: clip(input.title, 200)!,
            body: clip(input.body, 2000),
            link: input.link ?? null,
            entityType: input.entityType ?? null,
            entityId: input.entityId ?? null,
            audience: input.userId ? null : (input.audience ?? null),
            userId: input.userId ?? null,
            actorId: input.actorId ?? null,
            dedupeKey: input.dedupeKey ?? null,
          },
        ],
        skipDuplicates: true,
      });
    } catch (err) {
      this.logger.warn('failed to publish notification', {
        title: input.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Resolve free-text people references (an assignee, an @mention) to active
   * users by name or email, case-insensitively. Unknown names resolve to nothing.
   */
  async resolveUsers(refs: string[]): Promise<{ id: string; name: string }[]> {
    const wanted = [...new Set(refs.map((r) => r.trim().toLowerCase()).filter(Boolean))];
    if (!wanted.length) return [];
    const users = await this.prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, email: true } });
    return users.filter((u) => wanted.includes(u.name.toLowerCase()) || wanted.includes(u.email.toLowerCase()));
  }

  /** Active users @mentioned in a text — `@Full Name` or `@email`, case-insensitive. */
  async mentionedUsers(text: string): Promise<{ id: string; name: string }[]> {
    const body = text.toLowerCase();
    if (!body.includes('@')) return [];
    const users = await this.prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, email: true } });
    return users.filter((u) => (u.name && body.includes(`@${u.name.toLowerCase()}`)) || body.includes(`@${u.email.toLowerCase()}`));
  }

  private visibleTo(reader: Reader): PrismaNS.NotificationWhereInput {
    // SQL `actorId <> x` is never true for NULL, so "not caused by the reader" needs both arms.
    const notMine: PrismaNS.NotificationWhereInput = { OR: [{ actorId: null }, { actorId: { not: reader.id } }] };
    return {
      OR: [
        { userId: reader.id },
        { AND: [{ userId: null, audience: null }, notMine] },
        { AND: [{ userId: null, audience: { in: reader.permissions } }, notMine] },
      ],
    };
  }

  private async seenAt(userId: string): Promise<Date | null> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { notificationsSeenAt: true } });
    return u?.notificationsSeenAt ?? null;
  }

  private unreadWhere(reader: Reader, seenAt: Date | null): PrismaNS.NotificationWhereInput {
    return {
      ...(seenAt ? { createdAt: { gt: seenAt } } : {}),
      reads: { none: { userId: reader.id } },
    };
  }

  async unreadCount(reader: Reader): Promise<number> {
    const seenAt = await this.seenAt(reader.id);
    return this.prisma.notification.count({ where: { AND: [this.visibleTo(reader), this.unreadWhere(reader, seenAt)] } });
  }

  async list(reader: Reader, q: NotificationQuery): Promise<NotificationListDto> {
    const seenAt = await this.seenAt(reader.id);
    const and: PrismaNS.NotificationWhereInput[] = [this.visibleTo(reader)];
    if (q.unreadOnly) and.push(this.unreadWhere(reader, seenAt));
    if (q.category) and.push({ category: q.category });
    if (q.before) and.push({ createdAt: { lt: new Date(q.before) } });
    const [rows, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { AND: and },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        include: { reads: { where: { userId: reader.id }, select: { userId: true } } },
      }),
      this.unreadCount(reader),
    ]);
    const page = rows.slice(0, q.limit);
    const items: NotificationDto[] = page.map((n) => ({
      id: n.id,
      category: n.category as NotificationCategory,
      severity: n.severity as NotificationSeverity,
      title: n.title,
      body: n.body,
      link: n.link,
      entityType: n.entityType,
      entityId: n.entityId,
      personal: n.userId === reader.id,
      read: n.reads.length > 0 || (seenAt != null && n.createdAt <= seenAt),
      createdAt: n.createdAt.toISOString(),
    }));
    return {
      items,
      unread,
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.createdAt.toISOString() : null,
    };
  }

  /** Mark specific notifications read (only ones the reader can see). */
  async markRead(reader: Reader, ids: string[]): Promise<void> {
    const visible = await this.prisma.notification.findMany({
      where: { AND: [this.visibleTo(reader), { id: { in: ids } }] },
      select: { id: true },
    });
    if (!visible.length) return;
    await this.prisma.notificationRead.createMany({
      data: visible.map((n) => ({ notificationId: n.id, userId: reader.id })),
      skipDuplicates: true,
    });
  }

  /** Everything up to now counts as read — one row update, however many notifications exist. */
  async markAllRead(reader: Reader): Promise<void> {
    await this.prisma.user.update({ where: { id: reader.id }, data: { notificationsSeenAt: new Date() } });
  }

  /** Housekeeping: drop notifications past retention. */
  async purge(before = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 86_400_000)): Promise<number> {
    const r = await this.prisma.notification.deleteMany({ where: { createdAt: { lt: before } } });
    return r.count;
  }
}
