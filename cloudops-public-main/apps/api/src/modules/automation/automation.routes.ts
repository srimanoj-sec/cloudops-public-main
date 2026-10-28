import { Router } from 'express';
import { z } from 'zod';
import { automationRuleInputSchema, automationRunsQuerySchema } from '@cloudops/core';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import { actorOf } from '../audit/audit.service.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { AutomationService } from './automation.service.js';

/** Automation rules. Everyone may read them; changing or running them needs automation.manage. */
export function createAutomationRouter(
  automation: AutomationService,
  limit: RateLimiterFactory,
): Router {
  const router = Router();
  const manage = requirePermission('automation.manage');
  const heavy = limit({ name: 'automation-preview', windowMs: 60_000, max: 20, key: byUser });

  router.get(
    '/rules',
    asyncHandler(async (_req, res) => {
      res.json(await automation.list());
    }),
  );

  router.get(
    '/rules/:id',
    asyncHandler(async (req, res) => {
      res.json(await automation.get(req.params.id as string));
    }),
  );

  router.post(
    '/rules',
    manage,
    asyncHandler(async (req, res) => {
      res
        .status(201)
        .json(await automation.create(parse(automationRuleInputSchema, req.body), actorOf(req)));
    }),
  );

  router.put(
    '/rules/:id',
    manage,
    asyncHandler(async (req, res) => {
      res.json(
        await automation.update(
          req.params.id as string,
          parse(automationRuleInputSchema, req.body),
          actorOf(req),
        ),
      );
    }),
  );

  router.post(
    '/rules/:id/enabled',
    manage,
    asyncHandler(async (req, res) => {
      const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
      res.json(await automation.setEnabled(req.params.id as string, enabled, actorOf(req)));
    }),
  );

  router.delete(
    '/rules/:id',
    manage,
    asyncHandler(async (req, res) => {
      await automation.remove(req.params.id as string, actorOf(req));
      res.status(204).end();
    }),
  );

  // What a rule (draft or saved) would act on with today's data — changes nothing.
  router.post(
    '/preview',
    heavy,
    asyncHandler(async (req, res) => {
      const { ruleId, ...rule } = (req.body ?? {}) as { ruleId?: string };
      res.json(
        await automation.preview(
          parse(automationRuleInputSchema, rule),
          typeof ruleId === 'string' ? ruleId : undefined,
        ),
      );
    }),
  );

  router.post(
    '/rules/:id/run',
    manage,
    heavy,
    asyncHandler(async (req, res) => {
      res.json(await automation.runNow(req.params.id as string, actorOf(req)));
    }),
  );

  router.get(
    '/runs',
    asyncHandler(async (req, res) => {
      res.json(await automation.runs(parse(automationRunsQuerySchema, req.query)));
    }),
  );

  return router;
}
