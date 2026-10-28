import { Router } from 'express';
import {
  bulkExemptionSchema,
  complianceResultsQuerySchema,
  createExemptionSchema,
  createRuleSchema,
  createStandardSchema,
  previewRuleSchema,
  updateRuleSchema,
} from '@cloudops/core';
import { z } from 'zod';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import { actorOf, type AuditService } from '../audit/audit.service.js';
import { requirePermission } from '../auth/auth.middleware.js';
import type { StandardsService } from './standards.service.js';
import type { EvaluationJobs } from './evaluation.jobs.js';

export function createStandardsRouter(
  standards: StandardsService,
  audit: AuditService,
  limit: RateLimiterFactory,
  jobs: EvaluationJobs,
): Router {
  const router = Router();

  // Compliance summary + per-standard / per-rule scores.
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json(await standards.summary());
    }),
  );

  // The rule library: every rule that can be used, with what it checks and how to fix failures.
  router.get(
    '/library',
    asyncHandler(async (_req, res) => {
      res.json(standards.library());
    }),
  );

  // Dry-run a rule definition against the current inventory (nothing saved).
  router.post(
    '/rules/preview',
    requirePermission('standards.manage'),
    limit({ name: 'standards-preview', windowMs: 60_000, max: 60, key: byUser }),
    asyncHandler(async (req, res) => {
      res.json(await standards.preview(parse(previewRuleSchema, req.body)));
    }),
  );

  // ── Exemptions (accepted exceptions) ──
  router.get(
    '/exemptions',
    asyncHandler(async (req, res) => {
      const q = parse(z.object({ ruleId: z.string().optional(), resourceId: z.string().optional() }), req.query);
      res.json(await standards.listExemptions(q));
    }),
  );

  router.post(
    '/exemptions',
    requirePermission('standards.exempt'),
    asyncHandler(async (req, res) => {
      const input = parse(createExemptionSchema, req.body);
      const ex = await standards.createExemption(input, actorOf(req));
      await audit.record({
        action: 'standard.exemption.create',
        entity: 'standardRule',
        entityId: input.ruleId,
        actor: actorOf(req),
        metadata: { resourceId: input.resourceId, reason: input.reason, expiresAt: input.expiresAt ?? null },
      });
      res.status(201).json(ex);
    }),
  );

  router.post(
    '/exemptions/bulk',
    requirePermission('standards.exempt'),
    asyncHandler(async (req, res) => {
      const input = parse(bulkExemptionSchema, req.body);
      const result = await standards.createExemptions(input, actorOf(req));
      await audit.record({
        action: 'standard.exemption.create',
        entity: 'standardRule',
        entityId: input.ruleId,
        actor: actorOf(req),
        metadata: { resourceIds: input.resourceIds, count: result.created, reason: input.reason, expiresAt: input.expiresAt ?? null },
      });
      res.status(201).json(result);
    }),
  );

  router.delete(
    '/exemptions/:id',
    requirePermission('standards.exempt'),
    asyncHandler(async (req, res) => {
      const ex = await standards.deleteExemption(req.params.id as string);
      await audit.record({
        action: 'standard.exemption.delete',
        entity: 'standardRule',
        entityId: ex.ruleId,
        actor: actorOf(req),
        metadata: { resourceId: ex.resourceId, reason: ex.reason },
      });
      res.json(ex);
    }),
  );

  // Status of the background evaluation (running? how did the last one go?).
  router.get(
    '/evaluation',
    asyncHandler(async (_req, res) => {
      res.json(await jobs.status());
    }),
  );

  // Re-evaluate every rule against every resource. `?background=1` queues it
  // (202 + status to poll); without it the call waits and returns the summary
  // (kept for API clients written against the synchronous contract).
  router.post(
    '/evaluate',
    requirePermission('standards.evaluate'),
    limit({ name: 'standards-evaluate', windowMs: 60_000, max: 10, key: byUser }),
    asyncHandler(async (req, res) => {
      if (req.query.background === '1' || req.query.background === 'true') {
        const status = await jobs.enqueue('manual', actorOf(req)?.name ?? null);
        await audit.record({ action: 'standards.evaluate.queue', entity: 'standards', actor: actorOf(req), metadata: { deduplicated: status.deduplicated } });
        res.status(202).json(status);
        return;
      }
      const summary = await standards.evaluate();
      await audit.record({
        action: 'standards.evaluate',
        entity: 'standards',
        actor: actorOf(req),
        metadata: { score: summary.score, passed: summary.passed, failed: summary.failed },
      });
      res.json(summary);
    }),
  );

  // ── Custom standard / rule authoring (admin/operator) ──
  router.post(
    '/custom',
    requirePermission('standards.manage'),
    asyncHandler(async (req, res) => {
      const input = parse(createStandardSchema, req.body);
      const result = await standards.createStandard(input);
      await audit.record({
        action: 'standard.create',
        entity: 'standard',
        actor: actorOf(req),
        metadata: { name: input.name, templates: input.templates ?? [] },
      });
      res.status(201).json(result);
    }),
  );

  router.delete(
    '/custom/:id',
    requirePermission('standards.manage'),
    asyncHandler(async (req, res) => {
      const result = await standards.deleteStandard(req.params.id as string);
      await audit.record({ action: 'standard.delete', entity: 'standard', entityId: req.params.id as string, actor: actorOf(req) });
      res.json(result);
    }),
  );

  router.post(
    '/:standardId/rules',
    requirePermission('standards.manage'),
    asyncHandler(async (req, res) => {
      const input = parse(createRuleSchema, req.body);
      const result = await standards.createRule(req.params.standardId as string, input);
      await audit.record({
        action: 'standard.rule.create',
        entity: 'standard',
        entityId: req.params.standardId as string,
        actor: actorOf(req),
        metadata: {
          name: input.name,
          template: input.template ?? null,
          conditions: input.definition?.conditions.length ?? (input.field ? 1 : 0),
          severity: input.severity,
        },
      });
      res.status(201).json(result);
    }),
  );

  router.patch(
    '/rules/:id',
    requirePermission('standards.manage'),
    asyncHandler(async (req, res) => {
      const input = parse(updateRuleSchema, req.body);
      const result = await standards.updateRule(req.params.id as string, input);
      await audit.record({
        action: 'standard.rule.update',
        entity: 'standardRule',
        entityId: req.params.id as string,
        actor: actorOf(req),
        metadata: { ...input },
      });
      res.json(result);
    }),
  );

  router.delete(
    '/rules/:id',
    requirePermission('standards.manage'),
    asyncHandler(async (req, res) => {
      const result = await standards.deleteRule(req.params.id as string);
      await audit.record({ action: 'standard.rule.delete', entity: 'standardRule', entityId: req.params.id as string, actor: actorOf(req) });
      res.json(result);
    }),
  );

  // Drilldown: the resources passing/failing a given rule.
  router.get(
    '/results',
    asyncHandler(async (req, res) => {
      res.json(await standards.results(parse(complianceResultsQuerySchema, req.query)));
    }),
  );

  // Per-resource compliance (resource detail Compliance tab).
  router.get(
    '/resources/:id',
    asyncHandler(async (req, res) => {
      res.json(await standards.resourceCompliance(req.params.id as string));
    }),
  );

  return router;
}
