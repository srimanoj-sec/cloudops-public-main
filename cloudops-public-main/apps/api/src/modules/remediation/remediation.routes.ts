import { Router, type Request } from 'express';
import {
  createRemediationSchema,
  decideRemediationSchema,
  remediationQuerySchema,
  remediationTargetingSchema,
} from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { AppError } from '../../http/errors.js';
import { parse } from '../../http/validate.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { Actor, RemediationService } from './remediation.service.js';

function actor(req: Request): Actor {
  if (!req.user) throw AppError.unauthorized();
  return {
    id: req.user.id,
    name: req.user.name || req.user.email,
    permissions: req.user.permissions,
  };
}

/**
 * Remediation (mounted behind requireAuth). Reading the catalog, plans and runs
 * is open to every signed-in user; requesting, approving and executing are
 * separate permissions, and approval is four-eyes for medium/high risk.
 */
export function createRemediationRouter(
  remediation: RemediationService,
  limit: RateLimiterFactory,
): Router {
  const router = Router();
  const writeLimit = limit({ name: 'remediation-write', windowMs: 60_000, max: 30, key: byUser });

  router.get(
    '/actions',
    asyncHandler(async (_req, res) => {
      res.json(remediation.actions());
    }),
  );

  // Dry run: what would change, on which resources, with the exact commands. Nothing is saved.
  router.post(
    '/plan',
    limit({ name: 'remediation-plan', windowMs: 60_000, max: 120, key: byUser }),
    asyncHandler(async (req, res) => {
      res.json(await remediation.plan(parse(remediationTargetingSchema, req.body)));
    }),
  );

  router.get(
    '/runs',
    asyncHandler(async (req, res) => {
      res.json(await remediation.list(parse(remediationQuerySchema, req.query)));
    }),
  );

  router.post(
    '/runs',
    requirePermission('remediation.request'),
    writeLimit,
    asyncHandler(async (req, res) => {
      res
        .status(201)
        .json(await remediation.request(parse(createRemediationSchema, req.body), actor(req)));
    }),
  );

  router.get(
    '/runs/:id',
    asyncHandler(async (req, res) => {
      res.json(await remediation.detail(req.params.id as string, actor(req)));
    }),
  );

  router.post(
    '/runs/:id/decision',
    requirePermission('remediation.approve'),
    writeLimit,
    asyncHandler(async (req, res) => {
      res.json(
        await remediation.decide(
          req.params.id as string,
          parse(decideRemediationSchema, req.body),
          actor(req),
        ),
      );
    }),
  );

  router.post(
    '/runs/:id/execute',
    requirePermission('remediation.execute'),
    writeLimit,
    asyncHandler(async (req, res) => {
      res.status(202).json(await remediation.execute(req.params.id as string, actor(req)));
    }),
  );

  router.post(
    '/runs/:id/cancel',
    requirePermission('remediation.request', 'remediation.approve'),
    writeLimit,
    asyncHandler(async (req, res) => {
      res.json(await remediation.cancel(req.params.id as string, actor(req)));
    }),
  );

  return router;
}
