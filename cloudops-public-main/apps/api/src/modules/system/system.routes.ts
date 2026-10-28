import { Router } from 'express';
import { asyncHandler } from '../../http/async.js';
import type { RateLimiterFactory } from '../../http/rate-limit.js';
import { byUser } from '../../http/rate-limit.js';
import { actorOf } from '../audit/audit.service.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { DuplicateResources } from './duplicates.js';
import type { SystemService } from './system.service.js';
import type { JobsService } from './jobs.service.js';
import { JOB_STATES } from '@cloudops/core';
import { z } from 'zod';
import { parse } from '../../http/validate.js';

/** System status + data-integrity tools (mounted behind requireAuth + requirePermission('system.read')). */
export function createSystemRouter(
  system: SystemService,
  duplicates: DuplicateResources,
  limit: RateLimiterFactory,
  jobs: JobsService,
): Router {
  const router = Router();
  const jobWrite = limit({ name: 'job-write', windowMs: 60_000, max: 30, key: byUser });

  router.get(
    '/queues/:name/jobs',
    asyncHandler(async (req, res) => {
      const { state, limit: take } = parse(
        z.object({
          state: z.enum(JOB_STATES).default('failed'),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        req.query,
      );
      res.json(await jobs.list(req.params.name as string, state, take));
    }),
  );

  router.get(
    '/queues/:name/jobs/:id',
    asyncHandler(async (req, res) => {
      res.json(await jobs.get(req.params.name as string, req.params.id as string));
    }),
  );

  router.post(
    '/queues/:name/jobs/:id/retry',
    requirePermission('system.manage'),
    jobWrite,
    asyncHandler(async (req, res) => {
      res.json(await jobs.retry(req.params.name as string, req.params.id as string, actorOf(req)));
    }),
  );

  router.post(
    '/queues/:name/jobs/:id/remove',
    requirePermission('system.manage'),
    jobWrite,
    asyncHandler(async (req, res) => {
      await jobs.remove(req.params.name as string, req.params.id as string, actorOf(req));
      res.status(204).end();
    }),
  );

  /** Same Azure resource stored more than once (id letter-case) — what a merge would do. */
  router.get(
    '/duplicates',
    asyncHandler(async (_req, res) => {
      res.json(await duplicates.preview());
    }),
  );

  router.post(
    '/duplicates/merge',
    requirePermission('system.manage'),
    limit({ name: 'duplicates-merge', windowMs: 60_000, max: 3, key: byUser }),
    asyncHandler(async (req, res) => {
      res.json(await duplicates.merge(actorOf(req)));
    }),
  );

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      res.json(await system.status());
    }),
  );
  return router;
}
