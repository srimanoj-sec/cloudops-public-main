import { Router } from 'express';
import { inventoryGroupsQuerySchema, resourceQuerySchema } from '@cloudops/core';
import { z } from 'zod';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import type { InventoryService } from './inventory.service.js';
import type { ResourceOpsService } from './resource-ops.service.js';
import { actorOf } from '../audit/audit.service.js';
import { requirePermission } from '../auth/auth.middleware.js';

/** Single-resource operations (mounted under /api/inventory): refresh from the provider, re-evaluate. */
export function createResourceOpsRouter(ops: ResourceOpsService, limit: RateLimiterFactory): Router {
  const router = Router();
  const opsLimit = limit({ name: 'resource-ops', windowMs: 60_000, max: 30, key: byUser });
  router.post(
    '/resources/:id/refresh',
    requirePermission('resource.operate'),
    opsLimit,
    asyncHandler(async (req, res) => {
      res.json(await ops.refresh(req.params.id as string, actorOf(req)));
    }),
  );
  // Re-evaluate several resources at once (inventory bulk action).
  router.post(
    '/resources/evaluate',
    requirePermission('standards.evaluate', 'resource.operate'),
    opsLimit,
    asyncHandler(async (req, res) => {
      const { ids } = parse(z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) }), req.body);
      res.json(await ops.evaluateMany(ids, actorOf(req)));
    }),
  );
  router.post(
    '/resources/:id/evaluate',
    requirePermission('standards.evaluate', 'resource.operate'),
    opsLimit,
    asyncHandler(async (req, res) => {
      await ops.evaluate(req.params.id as string, actorOf(req));
      res.status(204).end();
    }),
  );
  return router;
}

export function createInventoryRouter(inventory: InventoryService, limit: RateLimiterFactory): Router {
  const router = Router();

  router.get(
    '/resources',
    asyncHandler(async (req, res) => {
      const query = parse(resourceQuerySchema, req.query);
      res.json(await inventory.listResources(query));
    }),
  );

  /**
   * CSV export of every resource matching the same filters as /resources
   * (pagination ignored; capped at 50,000 rows). Streamed — constant memory.
   */
  router.get(
    '/resources/export.csv',
    limit({ name: 'inventory-export', windowMs: 60_000, max: 10, key: byUser }),
    asyncHandler(async (req, res) => {
      const query = parse(resourceQuerySchema, req.query);
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="cloudops-inventory-${stamp}.csv"`);
      res.write('\uFEFF'); // BOM so Excel reads UTF-8 (₹, accents) correctly
      for await (const chunk of inventory.exportCsv(query)) {
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      }
      res.end();
    }),
  );

  // The filtered inventory grouped (by resource group, subscription, category…).
  router.get(
    '/resources/groups',
    asyncHandler(async (req, res) => {
      const q = parse(inventoryGroupsQuerySchema, req.query);
      res.json(await inventory.groups(q, q.groupBy));
    }),
  );

  // Org › subscription › resource group with counts (scope navigator).
  router.get(
    '/tree',
    asyncHandler(async (req, res) => {
      const { states } = parse(z.object({ states: z.string().optional() }), req.query);
      const list = (states ?? 'active').split(',').map((s) => s.trim()).filter((s) => s === 'active' || s === 'deleted');
      res.json(await inventory.tree(list.length ? list : ['active']));
    }),
  );

  router.get(
    '/resources/facets',
    asyncHandler(async (_req, res) => {
      res.json(await inventory.facets());
    }),
  );

  router.get(
    '/resources/:id/activity',
    asyncHandler(async (req, res) => {
      res.json(await inventory.activity(req.params.id as string));
    }),
  );

  router.get(
    '/resources/:id/history',
    asyncHandler(async (req, res) => {
      res.json(await inventory.getResourceHistory(req.params.id as string));
    }),
  );

  router.get(
    '/resources/:id',
    asyncHandler(async (req, res) => {
      res.json(await inventory.getResource(req.params.id as string));
    }),
  );

  router.get(
    '/organizations',
    asyncHandler(async (req, res) => {
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
      res.json(await inventory.listOrganizations(tenantId));
    }),
  );

  router.get(
    '/subscriptions',
    asyncHandler(async (req, res) => {
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
      res.json(await inventory.listSubscriptions(tenantId));
    }),
  );

  router.get(
    '/resource-groups',
    asyncHandler(async (req, res) => {
      const subscriptionId = typeof req.query.subscriptionId === 'string' ? req.query.subscriptionId : undefined;
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
      res.json(await inventory.listResourceGroups(subscriptionId, tenantId));
    }),
  );

  return router;
}
