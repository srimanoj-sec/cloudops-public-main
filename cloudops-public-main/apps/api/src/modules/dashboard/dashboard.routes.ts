import { Router } from 'express';
import { asyncHandler } from '../../http/async.js';
import type { DashboardService } from './dashboard.service.js';

export function createDashboardRouter(dashboard: DashboardService): Router {
  const router = Router();
  router.get(
    '/summary',
    asyncHandler(async (req, res) => {
      const tenantId = typeof req.query.tenantId === 'string' && req.query.tenantId ? req.query.tenantId : undefined;
      res.json(await dashboard.summary(tenantId));
    }),
  );
  // Operations Command Center — cross-module overview (health, cost, compliance, work).
  router.get(
    '/overview',
    asyncHandler(async (req, res) => {
      const tenantId = typeof req.query.tenantId === 'string' && req.query.tenantId ? req.query.tenantId : undefined;
      res.json(await dashboard.overview(tenantId));
    }),
  );
  return router;
}
