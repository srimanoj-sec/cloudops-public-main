import { Router } from 'express';
import { driftQuerySchema } from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import type { DriftService } from './drift.service.js';

/** Drift explorer (mounted behind requireAuth). */
export function createDriftRouter(drift: DriftService, limit: RateLimiterFactory): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json(await drift.list(parse(driftQuerySchema, req.query)));
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      res.json(await drift.get(req.params.id as string));
    }),
  );

  // Calls the provider — rate limited.
  router.get(
    '/:id/activity',
    limit({ name: 'drift-activity', windowMs: 60_000, max: 20, key: byUser }),
    asyncHandler(async (req, res) => {
      res.json(await drift.activity(req.params.id as string));
    }),
  );

  return router;
}
