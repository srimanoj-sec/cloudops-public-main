import { Router } from 'express';
import {
  budgetInputSchema,
  costAnomaliesQuerySchema,
  finopsQuerySchema,
  finopsScopeQuerySchema,
  finopsSyncRequestSchema,
} from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import { actorOf } from '../audit/audit.service.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { FinopsService } from './finops.service.js';

export function createFinopsRouter(finops: FinopsService, limit: RateLimiterFactory): Router {
  const router = Router();

  // Enqueue a cost sync (admin/operator only — it calls Azure).
  router.post(
    '/sync',
    requirePermission('finops.sync'),
    limit({ name: 'finops-sync', windowMs: 60_000, max: 5, key: byUser }),
    asyncHandler(async (req, res) => {
      const input = parse(finopsSyncRequestSchema, { ...(req.body ?? {}), providerKey: 'azure' });
      res.status(202).json(await finops.enqueue(input, actorOf(req)));
    }),
  );

  // This month (to date, forecast, vs last month), unattributed spend, savings, budgets.
  router.get(
    '/overview',
    asyncHandler(async (req, res) => {
      res.json(await finops.overview(parse(finopsScopeQuerySchema, req.query)));
    }),
  );

  // ── Budgets (admin/operator write) ──
  router.post(
    '/budgets',
    requirePermission('finops.budget.manage'),
    asyncHandler(async (req, res) => {
      res.status(201).json(await finops.createBudget(parse(budgetInputSchema, req.body), actorOf(req)));
    }),
  );

  router.put(
    '/budgets/:id',
    requirePermission('finops.budget.manage'),
    asyncHandler(async (req, res) => {
      res.json(await finops.updateBudget(req.params.id as string, parse(budgetInputSchema, req.body), actorOf(req)));
    }),
  );

  router.delete(
    '/budgets/:id',
    requirePermission('finops.budget.manage'),
    asyncHandler(async (req, res) => {
      await finops.deleteBudget(req.params.id as string, actorOf(req));
      res.status(204).end();
    }),
  );

  // Recent cost-sync job status (queued/running/completed/failed) from the queue.
  router.get(
    '/runs',
    asyncHandler(async (_req, res) => {
      res.json(await finops.recentSyncs());
    }),
  );

  // Per-subscription cost data coverage: latest stored day and last sync outcome.
  router.get(
    '/coverage',
    asyncHandler(async (_req, res) => {
      res.json(await finops.coverage());
    }),
  );

  // Cost-spike monitor: resources whose latest daily cost jumped above baseline.
  router.get(
    '/anomalies',
    asyncHandler(async (req, res) => {
      res.json(await finops.costAnomalies(parse(costAnomaliesQuerySchema, req.query)));
    }),
  );

  // Cost explorer: flexible range + granularity + groupBy + scope filters + compare.
  router.get(
    '/query',
    asyncHandler(async (req, res) => {
      res.json(await finops.query(parse(finopsQuerySchema, req.query)));
    }),
  );

  router.get(
    '/resources/:id/trend',
    asyncHandler(async (req, res) => {
      res.json(await finops.resourceTrend(req.params.id as string));
    }),
  );

  return router;
}
