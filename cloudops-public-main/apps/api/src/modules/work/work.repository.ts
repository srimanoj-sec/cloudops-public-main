import type { Prisma as PrismaNS } from '@prisma/client';
import type { Prisma } from '../../infra/prisma.js';

const ITEM_INCLUDE = {
  links: true,
  labels: { include: { label: true } },
  _count: { select: { comments: true } },
} satisfies PrismaNS.WorkItemInclude;

export type WorkItemRow = PrismaNS.WorkItemGetPayload<{ include: typeof ITEM_INCLUDE }>;
export type WorkItemDetailRow = PrismaNS.WorkItemGetPayload<{
  include: typeof ITEM_INCLUDE & { comments: true };
}>;

export interface WorkItemData {
  title: string;
  description?: string | null;
  type: string;
  state: PrismaNS.WorkItemCreateInput['state'];
  priority: number;
  effort?: number | null;
  dueDate?: Date | null;
  assignee?: string | null;
  recurrence?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceLabel?: string | null;
  createdById?: string | null;
  createdBy?: string | null;
}
export interface WorkLinkInput {
  scopeType: string;
  scopeId: string;
}

/** Data-access for work items, their scope links, and comments. */
export class WorkRepository {
  constructor(private readonly prisma: Prisma) {}

  listItems(where: PrismaNS.WorkItemWhereInput, take = 500): Promise<WorkItemRow[]> {
    return this.prisma.workItem.findMany({
      where,
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      include: ITEM_INCLUDE,
      take,
    });
  }

  /**
   * Ids of work items linked to an organization or anything inside it
   * (subscription, resource group, resource) — resolved in SQL, so it stays
   * correct and fast however many items or resources there are.
   */
  async itemIdsInTenant(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT l."workItemId" AS id
      FROM "WorkItemLink" l
      LEFT JOIN "Subscription" s ON l."scopeType" = 'subscription' AND s.id = l."scopeId"
      LEFT JOIN "ResourceGroup" rg ON l."scopeType" = 'resourceGroup' AND rg.id = l."scopeId"
      LEFT JOIN "Subscription" rgs ON rgs.id = rg."subscriptionId"
      LEFT JOIN "Resource" r ON l."scopeType" = 'resource' AND r.id = l."scopeId"
      LEFT JOIN "Subscription" rs ON rs.id = r."subscriptionId"
      WHERE (l."scopeType" = 'organization' AND l."scopeId" = ${tenantId})
         OR s."tenantId" = ${tenantId} OR rgs."tenantId" = ${tenantId} OR rs."tenantId" = ${tenantId}`;
    return rows.map((r) => r.id);
  }

  countByState(where: PrismaNS.WorkItemWhereInput) {
    return this.prisma.workItem.groupBy({ by: ['state'], where, _count: { _all: true } });
  }

  countOverdue(where: PrismaNS.WorkItemWhereInput, now: Date) {
    return this.prisma.workItem.count({ where: { AND: [where, { state: { not: 'done' }, dueDate: { lt: now } }] } });
  }

  getItem(id: string): Promise<WorkItemDetailRow | null> {
    return this.prisma.workItem.findUnique({
      where: { id },
      include: { ...ITEM_INCLUDE, comments: { orderBy: { createdAt: 'asc' } } },
    });
  }

  createItem(data: WorkItemData, links: WorkLinkInput[]): Promise<WorkItemRow> {
    return this.prisma.workItem.create({
      data: {
        ...data,
        links: links.length
          ? { create: links.map((l) => ({ scopeType: l.scopeType, scopeId: l.scopeId })) }
          : undefined,
      },
      include: ITEM_INCLUDE,
    });
  }

  updateItem(id: string, data: PrismaNS.WorkItemUpdateInput): Promise<WorkItemRow> {
    return this.prisma.workItem.update({ where: { id }, data, include: ITEM_INCLUDE });
  }

  deleteItem(id: string) {
    return this.prisma.workItem.delete({ where: { id } });
  }

  addComment(workItemId: string, author: string, body: string) {
    return this.prisma.comment.create({ data: { workItemId, author, body } });
  }

  /** The item's audit trail, oldest first (its activity feed). */
  activity(id: string) {
    return this.prisma.auditLog.findMany({
      where: { entity: 'workItem', entityId: id },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  }

  // ── scope-name / org resolution (batched by the collected link ids) ──
  tenantsByIds(ids: string[]) {
    return this.prisma.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  }
  subscriptionsByIds(ids: string[]) {
    return this.prisma.subscription.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, tenantId: true },
    });
  }
  resourceGroupsByIds(ids: string[]) {
    return this.prisma.resourceGroup.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, subscription: { select: { tenantId: true } } },
    });
  }
  resourcesByIds(ids: string[]) {
    return this.prisma.resource.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, subscription: { select: { tenantId: true } } },
    });
  }
}
