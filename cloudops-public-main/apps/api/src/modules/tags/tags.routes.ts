import { Router } from 'express';
import { applyResourceGroupTagsSchema, setResourceTagsSchema } from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { actorOf } from '../audit/audit.service.js';
import { requirePermission } from '../auth/auth.middleware.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import type { TagJobsService } from './tag-jobs.js';
import type { TagsService } from './tags.service.js';

/**
 * Tag write-back routes (mounted under /api/inventory). Every write requires the
 * admin/operator role; the service additionally enforces the AZURE_ALLOW_WRITE
 * kill-switch and audits each operation.
 */
export function createTagsRouter(tags: TagsService, jobs: TagJobsService, limit: RateLimiterFactory): Router {
  const router = Router();
  const writeLimit = limit({ name: 'tag-write', windowMs: 60_000, max: 30, key: byUser });

  // Set the full desired tag set on a single resource.
  router.put(
    '/resources/:id/tags',
    requirePermission('inventory.tag'),
    writeLimit,
    asyncHandler(async (req, res) => {
      const { tags: desired } = parse(setResourceTagsSchema, req.body);
      res.json(await tags.setResourceTags(req.params.id as string, desired, actorOf(req)));
    }),
  );

  // Apply (merge) tags onto a resource group and every resource in it — synchronous.
  // Kept for API compatibility; the UI uses the background job below, which
  // cannot hit HTTP timeouts on large resource groups.
  router.put(
    '/resource-groups/:id/tags',
    requirePermission('inventory.tag'),
    writeLimit,
    asyncHandler(async (req, res) => {
      const { tags: apply } = parse(applyResourceGroupTagsSchema, req.body);
      res.json(await tags.applyResourceGroupTags(req.params.id as string, apply, actorOf(req)));
    }),
  );

  // Same operation as a background job with progress: 202 + job, then poll.
  router.post(
    '/resource-groups/:id/tags/jobs',
    requirePermission('inventory.tag'),
    writeLimit,
    asyncHandler(async (req, res) => {
      const { tags: apply } = parse(applyResourceGroupTagsSchema, req.body);
      res.status(202).json(await jobs.enqueue(req.params.id as string, apply, actorOf(req)));
    }),
  );

  router.get(
    '/tag-jobs/:jobId',
    asyncHandler(async (req, res) => {
      res.json(await jobs.get(req.params.jobId as string));
    }),
  );

  return router;
}
