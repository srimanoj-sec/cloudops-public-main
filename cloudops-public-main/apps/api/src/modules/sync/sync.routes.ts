import { Router } from 'express';
import { syncRequestSchema, syncRunsQuerySchema } from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import { actorOf } from '../audit/audit.service.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { SyncService } from './sync.service.js';

export function createSyncRouter(sync: SyncService, limit: RateLimiterFactory): Router {
  const router = Router();
  const enqueueLimit = limit({ name: 'sync-enqueue', windowMs: 60_000, max: 10, key: byUser });

  // Enqueue a provider sync. Restricted to admin/operator.
  router.post(
    '/',
    requirePermission('inventory.sync'),
    enqueueLimit,
    asyncHandler(async (req, res) => {
      const input = parse(syncRequestSchema, req.body ?? {});
      const run = await sync.enqueue(input, actorOf(req));
      res.status(202).json(run);
    }),
  );

  // Convenience alias matching the plan's verification (POST /api/sync/azure).
  router.post(
    '/azure',
    requirePermission('inventory.sync'),
    enqueueLimit,
    asyncHandler(async (req, res) => {
      const input = parse(syncRequestSchema, { ...(req.body ?? {}), providerKey: 'azure' });
      const run = await sync.enqueue(input, actorOf(req));
      res.status(202).json(run);
    }),
  );

  router.get(
    '/runs',
    asyncHandler(async (req, res) => {
      res.json(await sync.listRuns(parse(syncRunsQuerySchema, req.query)));
    }),
  );

  router.get(
    '/runs/:id',
    asyncHandler(async (req, res) => {
      res.json(await sync.getRun(req.params.id as string));
    }),
  );

  router.post(
    '/runs/:id/cancel',
    requirePermission('inventory.sync'),
    asyncHandler(async (req, res) => {
      res.json(await sync.cancel(req.params.id as string, actorOf(req)));
    }),
  );

  // Field-level changes a single run detected — powers the "what changed" drilldown.
  router.get(
    '/runs/:id/changes',
    asyncHandler(async (req, res) => {
      res.json(await sync.runChanges(req.params.id as string));
    }),
  );

  return router;
}
