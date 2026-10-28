import { Router } from 'express';
import {
  createCommentSchema,
  createWorkItemSchema,
  updateWorkItemSchema,
  workItemQuerySchema,
} from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { requirePermission } from '../auth/auth.middleware.js';
import { actorOf, type AuditService } from '../audit/audit.service.js';
import type { WorkService } from './work.service.js';

export function createWorkRouter(work: WorkService, audit: AuditService): Router {
  const router = Router();

  router.get(
    '/items',
    asyncHandler(async (req, res) => {
      res.json(await work.list(parse(workItemQuerySchema, req.query)));
    }),
  );

  router.get(
    '/summary',
    asyncHandler(async (req, res) => {
      res.json(await work.summary(parse(workItemQuerySchema, req.query)));
    }),
  );

  router.get(
    '/items/:id',
    asyncHandler(async (req, res) => {
      res.json(await work.detail(req.params.id as string));
    }),
  );

  router.post(
    '/items',
    requirePermission('work.manage'),
    asyncHandler(async (req, res) => {
      res.status(201).json(await work.create(parse(createWorkItemSchema, req.body), actorOf(req)));
    }),
  );

  router.patch(
    '/items/:id',
    requirePermission('work.manage'),
    asyncHandler(async (req, res) => {
      res.json(await work.update(req.params.id as string, parse(updateWorkItemSchema, req.body), actorOf(req)));
    }),
  );

  router.delete(
    '/items/:id',
    requirePermission('work.manage'),
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const item = await work.detail(id);
      await work.remove(id);
      await audit.record({
        action: 'work.item.delete',
        entity: 'workItem',
        entityId: id,
        actor: actorOf(req),
        metadata: { title: item.title, type: item.type, state: item.state },
      });
      res.status(204).end();
    }),
  );

  router.post(
    '/items/:id/comments',
    requirePermission('work.manage'),
    asyncHandler(async (req, res) => {
      const { body } = parse(createCommentSchema, req.body);
      const author = req.user?.name ?? req.user?.email ?? 'unknown';
      res.status(201).json(await work.addComment(req.params.id as string, author, body, actorOf(req)));
    }),
  );

  return router;
}
