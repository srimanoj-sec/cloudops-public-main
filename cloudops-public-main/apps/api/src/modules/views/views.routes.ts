import { Router } from 'express';
import { createSavedViewSchema, savedViewQuerySchema, updateSavedViewSchema } from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { actorOf, type AuditService } from '../audit/audit.service.js';
import { can } from '../auth/auth.middleware.js';
import type { ViewsService } from './views.service.js';

export function createViewsRouter(views: ViewsService, audit: AuditService): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { scope } = parse(savedViewQuerySchema, req.query);
      res.json(await views.list(scope));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = parse(createSavedViewSchema, req.body);
      res.status(201).json(await views.create(input, req.user?.id ?? null));
    }),
  );

  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const caller = { userId: req.user?.id ?? null, canOperate: can(req, 'views.manage') };
      res.json(await views.update(req.params.id as string, parse(updateSavedViewSchema, req.body), caller));
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const caller = { userId: req.user?.id ?? null, canOperate: can(req, 'views.manage') };
      const removed = await views.remove(req.params.id as string, caller);
      await audit.record({
        action: 'view.delete',
        entity: 'savedView',
        entityId: removed.id,
        actor: actorOf(req),
        metadata: { name: removed.name, scope: removed.scope },
      });
      res.status(204).end();
    }),
  );

  return router;
}
