import express, { type Express } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { API_VERSION, config, corsOrigins } from './env.js';
import { errorHandler } from './http/errors.js';
import { accessLog, apiNotFound, noStore, requestContext } from './http/middleware.js';
import { createHealthRouter } from './http/health.js';
import { createMetricsRouter, httpMetrics } from './infra/metrics.js';
import { allQueues } from './infra/queue.js';
import { createRateLimiter } from './http/rate-limit.js';
import { openApiDocument } from './openapi/doc.js';
import type { AppComposition } from './composition.js';
import { prisma } from './infra/prisma.js';
import { fastRedis } from './infra/redis.js';

import { createAuthRouter } from './modules/auth/auth.routes.js';
import { requireAuth, requirePermission } from './modules/auth/auth.middleware.js';
import { createProvidersRouter } from './modules/providers/providers.routes.js';
import { createGcpInsightsRouter } from './modules/providers/gcp-insights.routes.js';
import {
  createInventoryRouter,
  createResourceOpsRouter,
} from './modules/inventory/inventory.routes.js';
import { createSyncRouter } from './modules/sync/sync.routes.js';
import { createFinopsRouter } from './modules/finops/finops.routes.js';
import { createTopologyRouter } from './modules/topology/topology.routes.js';
import { createViewsRouter } from './modules/views/views.routes.js';
import { createDashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { createWorkRouter } from './modules/work/work.routes.js';
import { createWorkspacesRouter } from './modules/workspaces/workspaces.routes.js';
import { createStandardsRouter } from './modules/standards/standards.routes.js';
import { createTagsRouter } from './modules/tags/tags.routes.js';
import { createDirectoryRouter, createUsersRouter } from './modules/users/users.routes.js';
import { createAuditRouter } from './modules/audit/audit.routes.js';
import { createSystemRouter } from './modules/system/system.routes.js';
import { createNotificationsRouter } from './modules/notifications/notifications.routes.js';
import { createSearchRouter } from './modules/search/search.routes.js';
import { createRemediationRouter } from './modules/remediation/remediation.routes.js';
import { createDriftRouter } from './modules/drift/drift.routes.js';
import { createAutomationRouter } from './modules/automation/automation.routes.js';

export { API_VERSION };

export function createApp(app_: AppComposition): Express {
  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');

  // Correlation id + structured access log first, so everything after is traceable.
  app.use(requestContext());
  app.use(accessLog());
  app.use(httpMetrics());
  app.use(
    helmet({
      // JSON API + Swagger UI; the SPA sets its own CSP (served by nginx).
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'Retry-After', 'X-Export-Truncated'],
    }),
  );
  // gzip/brotli-less deflate for JSON + CSV: inventory pages, topology and
  // exports shrink ~5-10x — the difference between snappy and sluggish on a
  // slow link. (Below 1 KB it isn't worth the CPU; the default threshold.)
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));

  // Liveness / readiness (Postgres + Redis).
  app.use(createHealthRouter({ prisma, redis: fastRedis, version: API_VERSION }));
  // Prometheus scrape endpoint — only when METRICS_TOKEN is configured.
  app.use(createMetricsRouter(allQueues, config.METRICS_TOKEN));

  // API documentation.
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));
  app.get('/api/openapi.json', (_req, res) => res.json(openApiDocument));

  // Everything under /api carries user/estate data — never cache it.
  app.use('/api', noStore());
  const limit = createRateLimiter(fastRedis, config.RATE_LIMIT_ENABLED);

  // Public auth routes (login/refresh/logout); /me and /password require a token.
  app.use('/api/auth', createAuthRouter(app_.auth, limit));

  // Everything below requires a valid access token for an active user.
  const authed = requireAuth(app_.auth);
  // Cloud credentials are admin-only to write; everyone authenticated can see
  // which organizations are configured (secrets are never in a response).
  app.use(
    '/api/providers',
    authed,
    createProvidersRouter(
      app_.registry,
      app_.credentials,
      prisma,
      app_.providerAccounts,
      requirePermission('provider.manage'),
      app_.audit,
      limit,
    ),
  );
  app.use(
    '/api/providers/gcp-insights',
    authed,
    createGcpInsightsRouter(
      app_.registry,
      app_.credentials,
      app_.providerAccounts,
      prisma,
      app_.audit,
      limit,
    ),
  );
  app.use('/api/inventory', authed, createInventoryRouter(app_.inventory, limit));
  app.use('/api/inventory', authed, createTagsRouter(app_.tags, app_.tagJobs, limit));
  app.use('/api/inventory', authed, createResourceOpsRouter(app_.resourceOps, limit));
  app.use('/api/sync', authed, createSyncRouter(app_.sync, limit));
  app.use('/api/finops', authed, createFinopsRouter(app_.finops, limit));
  app.use('/api/topology', authed, createTopologyRouter(app_.topology));
  app.use('/api/views', authed, createViewsRouter(app_.views, app_.audit));
  app.use('/api/dashboard', authed, createDashboardRouter(app_.dashboard));
  app.use('/api/work', authed, createWorkRouter(app_.work, app_.audit));
  app.use('/api/workspaces', authed, createWorkspacesRouter(app_.workspaces, app_.audit));
  app.use(
    '/api/standards',
    authed,
    createStandardsRouter(app_.standards, app_.audit, limit, app_.evaluationJobs),
  );
  app.use('/api/notifications', authed, createNotificationsRouter(app_.notifications));
  app.use('/api/search', authed, createSearchRouter(app_.search, limit));
  app.use('/api/remediation', authed, createRemediationRouter(app_.remediation, limit));
  app.use('/api/drift', authed, createDriftRouter(app_.drift, limit));
  app.use('/api/automation', authed, createAutomationRouter(app_.automation, limit));
  app.use('/api/directory', authed, createDirectoryRouter(app_.users));
  // Administration.
  app.use(
    '/api/users',
    authed,
    requirePermission('users.manage'),
    createUsersRouter(app_.users, limit, app_.auth),
  );
  app.use(
    '/api/audit',
    authed,
    requirePermission('audit.read'),
    createAuditRouter(app_.audit, limit),
  );
  app.use(
    '/api/system',
    authed,
    requirePermission('system.read'),
    createSystemRouter(app_.system, app_.duplicates, limit, app_.jobs),
  );

  app.use('/api', apiNotFound());
  app.use(errorHandler);
  return app;
}
