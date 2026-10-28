import { Prisma as PrismaNS } from '@prisma/client';
import { Router, type Request } from 'express';
import type { CredentialChain } from '@cloudops/credentials';
import type { ProviderContext, ProviderRegistry } from '@cloudops/provider-sdk';
import { asyncHandler } from '../../http/async.js';
import { AppError } from '../../http/errors.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import { requirePermission } from '../auth/auth.middleware.js';
import { actorOf, type AuditService } from '../audit/audit.service.js';
import type { Prisma } from '../../infra/prisma.js';
import type { ProviderAccountsService } from './provider-accounts.service.js';

const CAPABILITIES = ['security', 'metrics', 'rbac', 'health', 'recommendations'] as const;
type InsightCapability = (typeof CAPABILITIES)[number];

function actor(req: Request) {
  if (!req.user) throw AppError.unauthorized();
  return actorOf(req);
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);
}

export function createGcpInsightsRouter(
  registry: ProviderRegistry,
  credentials: CredentialChain,
  providerAccounts: ProviderAccountsService,
  prisma: Prisma,
  audit: AuditService,
  limit: RateLimiterFactory,
): Router {
  const router = Router();
  const syncLimit = limit({ name: 'gcp-insights-sync', windowMs: 60_000, max: 10, key: byUser });
  const executeLimit = limit({ name: 'gcp-vm-execute', windowMs: 60_000, max: 20, key: byUser });

  function gcpProvider() {
    const provider = registry.get('gcp');
    if (
      !provider.getSecurityFindings ||
      !provider.getMetrics ||
      !provider.getRoleAssignments ||
      !provider.getHealthEvents ||
      !provider.getRecommendations ||
      !provider.executeAction ||
      !provider.previewAction
    ) {
      throw AppError.conflict('The registered Google Cloud provider does not support insights.');
    }
    return provider;
  }

  async function context(): Promise<ProviderContext> {
    return {
      credential: await credentials.resolve({ providerKey: 'gcp' }),
      log: () => {},
    };
  }

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const snapshots = await prisma.providerInsightSnapshot.findMany({
        where: { providerKey: 'gcp' },
        orderBy: [{ projectId: 'asc' }, { capability: 'asc' }],
      });
      const projects = providerAccounts.resolve('gcp').map(({ name, tenantId }) => ({
        name,
        projectId: tenantId,
      }));
      const vmTargets = await prisma.resource.findMany({
        where: {
          providerKey: 'gcp',
          state: 'active',
          type: { equals: 'compute.googleapis.com/Instance', mode: 'insensitive' },
        },
        select: { externalId: true, name: true, location: true },
        orderBy: { name: 'asc' },
      });
      res.json({ projects, snapshots, vmTargets });
    }),
  );

  router.post(
    '/sync',
    requirePermission('inventory.sync'),
    syncLimit,
    asyncHandler(async (_req, res) => {
      const provider = gcpProvider();
      const accounts = providerAccounts.resolve('gcp');
      if (accounts.length === 0) {
        throw AppError.badRequest('Add and enable a Google Cloud project in Providers before syncing insights.');
      }
      const ctx = await context();
      const now = new Date();
      const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const to = now.toISOString();
      const snapshots = [];

      for (const account of accounts) {
        const projectId = account.tenantId;
        const scope = `projects/${projectId}`;
        const requests: Record<InsightCapability, () => Promise<unknown[]>> = {
          security: () => provider.getSecurityFindings!(scope, ctx),
          metrics: () => provider.getMetrics!(scope, from, to, ctx),
          rbac: () => provider.getRoleAssignments!(scope, ctx),
          health: () => provider.getHealthEvents!(scope, ctx),
          recommendations: () => provider.getRecommendations!(scope, ctx),
        };

        for (const capability of CAPABILITIES) {
          let data: unknown[] = [];
          let error: string | null = null;
          try {
            data = await requests[capability]();
          } catch (cause) {
            error = errorMessage(cause);
          }
          const snapshot = await prisma.providerInsightSnapshot.upsert({
            where: {
              providerKey_projectId_capability: {
                providerKey: 'gcp',
                projectId,
                capability,
              },
            },
            create: {
              providerKey: 'gcp',
              projectId,
              capability,
              data: data as PrismaNS.InputJsonValue,
              error,
              syncedAt: now,
            },
            update: {
              ...(error ? {} : { data: data as PrismaNS.InputJsonValue }),
              error,
              syncedAt: now,
            },
          });
          snapshots.push({
            projectId,
            projectName: account.name,
            capability,
            count: data.length,
            error,
            syncedAt: snapshot.syncedAt,
          });
        }
      }
      res.json({ snapshots });
    }),
  );

  router.post(
    '/execute',
    requirePermission('remediation.execute'),
    executeLimit,
    asyncHandler(async (req, res) => {
      const body = req.body as { externalId?: unknown; operation?: unknown };
      if (
        typeof body.externalId !== 'string' ||
        !['start', 'stop'].includes(String(body.operation))
      ) {
        throw AppError.badRequest('Execution supports only start or stop on a Compute Engine VM.');
      }
      const target = await prisma.resource.findFirst({
        where: {
          providerKey: 'gcp',
          externalId: body.externalId,
          state: 'active',
          type: { equals: 'compute.googleapis.com/Instance', mode: 'insensitive' },
        },
        select: { id: true, name: true, externalId: true },
      });
      if (!target) throw AppError.notFound('Active Google Cloud VM not found in synced inventory.');

      const provider = gcpProvider();
      const action = {
        kind: 'power' as const,
        operation: body.operation as 'start' | 'stop',
        externalId: target.externalId,
      };
      const preview = provider.previewAction!(action);
      const ctx = await context();
      const result = await provider.executeAction!(action, ctx);
      await audit.record({
        action: `gcp.vm.${action.operation}`,
        entity: 'resource',
        entityId: target.id,
        actor: actor(req),
        metadata: { provider: 'gcp', resourceName: target.name, preview },
      });
      res.json({ message: result.message ?? `VM ${action.operation} request submitted.`, preview });
    }),
  );

  return router;
}
