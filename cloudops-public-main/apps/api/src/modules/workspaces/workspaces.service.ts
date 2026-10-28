import type {
  CreateDocumentRequest,
  DocumentDto,
  DocumentRevisionDto,
  ScopeWorkspaceDto,
  UpdateDocumentRequest,
  WorkspaceDetailDto,
  WorkspaceDto,
} from '@cloudops/core';
import { AppError } from '../../http/errors.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import type { WorkspaceRow, WorkspacesRepository } from './workspaces.repository.js';

type DocRow = WorkspaceRow['documents'][number];

function toDocumentDto(d: DocRow): DocumentDto {
  return {
    id: d.id,
    workspaceId: d.workspaceId,
    title: d.title,
    body: d.body,
    kind: d.kind,
    createdBy: d.createdBy ?? null,
    updatedBy: d.updatedBy ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

function toWorkspaceDto(w: WorkspaceRow, scopeName: string | null): WorkspaceDto {
  return {
    id: w.id,
    scopeType: w.scopeType,
    scopeId: w.scopeId,
    scopeName,
    title: w.title,
    documentCount: w._count.documents,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

function toWorkspaceDetailDto(w: WorkspaceRow, scopeName: string | null): WorkspaceDetailDto {
  return { ...toWorkspaceDto(w, scopeName), documents: w.documents.map(toDocumentDto) };
}

export class WorkspacesService {
  constructor(
    private readonly repo: WorkspacesRepository,
    private readonly audit?: AuditService,
  ) {}

  /** Resolve display names for a batch of scopes, keyed `scopeType:scopeId`. */
  private async resolveScopeNames(
    scopes: { scopeType: string; scopeId: string }[],
  ): Promise<Map<string, string>> {
    const byType = new Map<string, Set<string>>();
    for (const s of scopes) {
      if (!byType.has(s.scopeType)) byType.set(s.scopeType, new Set());
      byType.get(s.scopeType)!.add(s.scopeId);
    }
    const ids = (t: string) => [...(byType.get(t) ?? [])];
    const [tenants, subs, rgs, resources] = await Promise.all([
      this.repo.tenantsByIds(ids('organization')),
      this.repo.subscriptionsByIds(ids('subscription')),
      this.repo.resourceGroupsByIds(ids('resourceGroup')),
      this.repo.resourcesByIds(ids('resource')),
    ]);
    const names = new Map<string, string>();
    for (const t of tenants) names.set(`organization:${t.id}`, t.name);
    for (const s of subs) names.set(`subscription:${s.id}`, s.name);
    for (const rg of rgs) names.set(`resourceGroup:${rg.id}`, rg.name);
    for (const r of resources) names.set(`resource:${r.id}`, r.name);
    return names;
  }

  private async resolveOne(scopeType: string, scopeId: string): Promise<string | null> {
    const names = await this.resolveScopeNames([{ scopeType, scopeId }]);
    return names.get(`${scopeType}:${scopeId}`) ?? null;
  }

  async list(): Promise<WorkspaceDto[]> {
    const rows = await this.repo.listWorkspaces();
    const names = await this.resolveScopeNames(rows);
    return rows.map((w) => toWorkspaceDto(w, names.get(`${w.scopeType}:${w.scopeId}`) ?? null));
  }

  async getScope(scopeType: string, scopeId: string): Promise<ScopeWorkspaceDto> {
    const [row, scopeName] = await Promise.all([
      this.repo.getByScope(scopeType, scopeId),
      this.resolveOne(scopeType, scopeId),
    ]);
    return {
      scopeType,
      scopeId,
      scopeName,
      workspace: row ? toWorkspaceDetailDto(row, scopeName) : null,
    };
  }

  async createDocument(
    scopeType: string,
    scopeId: string,
    input: CreateDocumentRequest,
    actor: AuditActor | null = null,
  ): Promise<DocumentDto> {
    const scopeName = await this.resolveOne(scopeType, scopeId);
    const title = scopeName ?? `${scopeType} workspace`;
    const workspace = await this.repo.ensureForScope(scopeType, scopeId, title);
    const doc = await this.repo.createDocument(workspace.id, {
      title: input.title,
      kind: input.kind,
      body: input.body,
      createdBy: actor?.name ?? null,
      updatedBy: actor?.name ?? null,
    });
    await this.audit?.record({
      action: 'document.create',
      entity: 'document',
      entityId: doc.id,
      actor,
      metadata: { title: doc.title, kind: doc.kind, scopeType, scopeId },
    });
    return toDocumentDto(doc);
  }

  async getDocument(id: string): Promise<DocumentDto> {
    const doc = await this.repo.getDocument(id);
    if (!doc) throw AppError.notFound('Document not found');
    return toDocumentDto(doc);
  }

  /**
   * Edit a document. When its content changes, the previous version is kept as
   * a revision (with who wrote it), so every edit can be seen and undone.
   */
  async updateDocument(
    id: string,
    input: UpdateDocumentRequest,
    actor: AuditActor | null = null,
  ): Promise<DocumentDto> {
    const existing = await this.repo.getDocument(id);
    if (!existing) throw AppError.notFound('Document not found');
    const changed = (['title', 'body', 'kind'] as const).filter(
      (k) => input[k] !== undefined && input[k] !== existing[k],
    );
    if (!changed.length) return toDocumentDto(existing);
    const doc = await this.repo.updateWithRevision(
      {
        id,
        title: existing.title,
        body: existing.body,
        kind: existing.kind,
        author: existing.updatedBy ?? existing.createdBy,
      },
      { ...input, updatedBy: actor?.name ?? null },
    );
    await this.repo.touchWorkspace(doc.workspaceId);
    await this.audit?.record({
      action: 'document.update',
      entity: 'document',
      entityId: id,
      actor,
      metadata: { title: doc.title, changed },
    });
    return toDocumentDto(doc);
  }

  async revisions(id: string): Promise<DocumentRevisionDto[]> {
    if (!(await this.repo.getDocument(id))) throw AppError.notFound('Document not found');
    const rows = await this.repo.listRevisions(id);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      author: r.author,
      createdAt: r.createdAt.toISOString(),
      length: r.body.length,
    }));
  }

  async revision(id: string, revisionId: string): Promise<DocumentRevisionDto> {
    const r = await this.repo.getRevision(id, revisionId);
    if (!r) throw AppError.notFound('Revision not found');
    return {
      id: r.id,
      title: r.title,
      kind: r.kind,
      author: r.author,
      createdAt: r.createdAt.toISOString(),
      body: r.body,
      length: r.body.length,
    };
  }

  /** Put a previous version back. The current one becomes a revision, so a restore can itself be undone. */
  async restore(id: string, revisionId: string, actor: AuditActor | null): Promise<DocumentDto> {
    const r = await this.repo.getRevision(id, revisionId);
    if (!r) throw AppError.notFound('Revision not found');
    const doc = await this.updateDocument(
      id,
      { title: r.title, body: r.body, kind: r.kind as UpdateDocumentRequest['kind'] },
      actor,
    );
    await this.audit?.record({
      action: 'document.restore',
      entity: 'document',
      entityId: id,
      actor,
      metadata: { revisionId, from: r.createdAt.toISOString() },
    });
    return doc;
  }

  async deleteDocument(id: string): Promise<void> {
    const existing = await this.repo.getDocument(id);
    if (!existing) throw AppError.notFound('Document not found');
    await this.repo.deleteDocument(id);
  }
}
