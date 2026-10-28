import { Router } from 'express';
import { auditQuerySchema } from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import { actorOf, type AuditService } from './audit.service.js';

/** Audit trail (mounted behind requireAuth + requirePermission('audit.read')). */
export function createAuditRouter(audit: AuditService, limit: RateLimiterFactory): Router {
  const router = Router();

  router.get(
    '/actors',
    asyncHandler(async (_req, res) => {
      res.json(await audit.actors());
    }),
  );

  // CSV of the filtered log. Exporting is itself recorded.
  router.get(
    '/export',
    limit({ name: 'audit-export', windowMs: 60_000, max: 10, key: byUser }),
    asyncHandler(async (req, res) => {
      const { page: _page, pageSize: _size, ...q } = parse(auditQuerySchema, req.query);
      const out = await audit.exportCsv(q);
      await audit.record({
        action: 'audit.export',
        entity: 'audit',
        actor: actorOf(req),
        metadata: { rows: out.rows, truncated: out.truncated, filters: q },
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="cloudops-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.setHeader('X-Export-Truncated', String(out.truncated));
      res.send(`\uFEFF${out.csv}`);
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json(await audit.list(parse(auditQuerySchema, req.query)));
    }),
  );

  router.get(
    '/actions',
    asyncHandler(async (_req, res) => {
      res.json(await audit.actions());
    }),
  );

  return router;
}
