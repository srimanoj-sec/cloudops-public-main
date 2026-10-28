import { Router } from 'express';
import { createDocumentSchema, updateDocumentSchema } from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { requirePermission } from '../auth/auth.middleware.js';
import { actorOf, type AuditService } from '../audit/audit.service.js';
import type { WorkspacesService } from './workspaces.service.js';

export function createWorkspacesRouter(workspaces: WorkspacesService, audit: AuditService): Router {
  const router = Router();

  // Index of every workspace across scopes (Workspaces page).
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json(await workspaces.list());
    }),
  );

  // The workspace + documents for a scope (null until the first doc). Powers the
  // per-entity Docs tab.
  router.get(
    '/scope/:scopeType/:scopeId',
    asyncHandler(async (req, res) => {
      res.json(
        await workspaces.getScope(req.params.scopeType as string, req.params.scopeId as string),
      );
    }),
  );

  // Create a document under a scope's workspace (auto-creating the workspace).
  router.post(
    '/scope/:scopeType/:scopeId/documents',
    requirePermission('docs.manage'),
    asyncHandler(async (req, res) => {
      const input = parse(createDocumentSchema, req.body);
      res
        .status(201)
        .json(
          await workspaces.createDocument(
            req.params.scopeType as string,
            req.params.scopeId as string,
            input,
            actorOf(req),
          ),
        );
    }),
  );

  router.get(
    '/documents/:id',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.getDocument(req.params.id as string));
    }),
  );

  router.patch(
    '/documents/:id',
    requirePermission('docs.manage'),
    asyncHandler(async (req, res) => {
      res.json(
        await workspaces.updateDocument(
          req.params.id as string,
          parse(updateDocumentSchema, req.body),
          actorOf(req),
        ),
      );
    }),
  );

  // Version history: every edit keeps the previous version.
  router.get(
    '/documents/:id/revisions',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.revisions(req.params.id as string));
    }),
  );

  router.get(
    '/documents/:id/revisions/:revisionId',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.revision(req.params.id as string, req.params.revisionId as string));
    }),
  );

  router.post(
    '/documents/:id/revisions/:revisionId/restore',
    requirePermission('docs.manage'),
    asyncHandler(async (req, res) => {
      res.json(
        await workspaces.restore(
          req.params.id as string,
          req.params.revisionId as string,
          actorOf(req),
        ),
      );
    }),
  );

  router.delete(
    '/documents/:id',
    requirePermission('docs.manage'),
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const doc = await workspaces.getDocument(id);
      await workspaces.deleteDocument(id);
      await audit.record({
        action: 'document.delete',
        entity: 'document',
        entityId: id,
        actor: actorOf(req),
        metadata: { title: doc.title, kind: doc.kind },
      });
      res.status(204).end();
    }),
  );

  return router;
}
