import { z } from 'zod';

/**
 * In-app notifications: things a person should know about without watching a
 * page — a sync failed, a remediation waits for approval, an exemption expires,
 * someone mentioned you. Each links to the object it is about.
 */

export const NOTIFICATION_CATEGORIES = ['sync', 'cost', 'compliance', 'work', 'remediation', 'automation', 'system'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  sync: 'Sync',
  cost: 'Cost',
  compliance: 'Compliance',
  work: 'Work',
  remediation: 'Remediation',
  automation: 'Automation',
  system: 'System',
};

export interface NotificationDto {
  id: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  /** In-app route to the object. */
  link: string | null;
  entityType: string | null;
  entityId: string | null;
  /** True when addressed to you personally (mention, assignment, your request). */
  personal: boolean;
  read: boolean;
  createdAt: string;
}

export interface NotificationListDto {
  items: NotificationDto[];
  unread: number;
  /** Pass as `before` to load older notifications; null when there are none. */
  nextCursor: string | null;
}

const bool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => v === true || v === 'true' || v === '1');

export const notificationQuerySchema = z.object({
  unreadOnly: bool,
  category: z.enum(NOTIFICATION_CATEGORIES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Cursor from a previous page (ISO time of the last item). */
  before: z.string().datetime({ offset: true }).optional(),
});
export type NotificationQuery = z.infer<typeof notificationQuerySchema>;

export const markNotificationsReadSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(200),
});
