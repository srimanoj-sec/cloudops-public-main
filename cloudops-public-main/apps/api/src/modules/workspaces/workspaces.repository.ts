import type { Prisma as PrismaNS } from '@prisma/client';
import type { Prisma } from '../../infra/prisma.js';

const WORKSPACE_INCLUDE = {
  documents: { orderBy: { updatedAt: 'desc' } },
  _count: { select: { documents: true } },
} satisfies PrismaNS.WorkspaceInclude;

export type WorkspaceRow = PrismaNS.WorkspaceGetPayload<{ include: typeof WORKSPACE_INCLUDE }>;

/** Data-access for resource workspaces + their markdown documents. */
export class WorkspacesRepository {
  constructor(private readonly prisma: Prisma) {}

  listWorkspaces(): Promise<WorkspaceRow[]> {
    return this.prisma.workspace.findMany({
      include: WORKSPACE_INCLUDE,
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
  }

  getByScope(scopeType: string, scopeId: string): Promise<WorkspaceRow | null> {
    return this.prisma.workspace.findUnique({
      where: { scopeType_scopeId: { scopeType, scopeId } },
      include: WORKSPACE_INCLUDE,
    });
  }

  getById(id: string): Promise<WorkspaceRow | null> {
    return this.prisma.workspace.findUnique({ where: { id }, include: WORKSPACE_INCLUDE });
  }

  /** Get the workspace for a scope, creating an empty one if it does not exist. */
  async ensureForScope(scopeType: string, scopeId: string, title: string): Promise<WorkspaceRow> {
    return this.prisma.workspace.upsert({
      where: { scopeType_scopeId: { scopeType, scopeId } },
      update: {},
      create: { scopeType, scopeId, title },
      include: WORKSPACE_INCLUDE,
    });
  }

  createDocument(
    workspaceId: string,
    data: {
      title: string;
      kind: string;
      body: string;
      createdBy?: string | null;
      updatedBy?: string | null;
    },
  ) {
    return this.prisma.document.create({ data: { workspaceId, ...data } });
  }

  getDocument(id: string) {
    return this.prisma.document.findUnique({ where: { id } });
  }

  updateDocument(
    id: string,
    data: { title?: string; kind?: string; body?: string; updatedBy?: string | null },
  ) {
    return this.prisma.document.update({ where: { id }, data });
  }

  /** Save the document as it is now, then apply the edit — atomically. */
  async updateWithRevision(
    current: { id: string; title: string; body: string; kind: string; author: string | null },
    data: { title?: string; kind?: string; body?: string; updatedBy?: string | null },
  ) {
    const [, doc] = await this.prisma.$transaction([
      this.prisma.documentRevision.create({
        data: {
          documentId: current.id,
          title: current.title,
          body: current.body,
          kind: current.kind,
          author: current.author,
        },
      }),
      this.prisma.document.update({ where: { id: current.id }, data }),
    ]);
    return doc;
  }

  listRevisions(documentId: string) {
    return this.prisma.documentRevision.findMany({
      where: { documentId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  getRevision(documentId: string, id: string) {
    return this.prisma.documentRevision.findFirst({ where: { id, documentId } });
  }

  /** Bump the parent workspace's updatedAt so recency sorting reflects edits. */
  touchWorkspace(id: string) {
    return this.prisma.workspace.update({ where: { id }, data: { updatedAt: new Date() } });
  }

  deleteDocument(id: string) {
    return this.prisma.document.delete({ where: { id } });
  }

  // ── scope-name resolution (batched by the collected scope ids) ──
  tenantsByIds(ids: string[]) {
    return this.prisma.tenant.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  }
  subscriptionsByIds(ids: string[]) {
    return this.prisma.subscription.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  }
  resourceGroupsByIds(ids: string[]) {
    return this.prisma.resourceGroup.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  }
  resourcesByIds(ids: string[]) {
    return this.prisma.resource.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  }
}
