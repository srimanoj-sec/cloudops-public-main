import { createKernel, type Kernel } from '@cloudops/kernel';
import {
  AzureCliCredentialProvider,
  CredentialChain,
  EncryptedJsonStore,
  EnvCredentialProvider,
  type CredentialProvider,
} from '@cloudops/credentials';
import { ProviderRegistry, PROVIDER_REGISTRY } from '@cloudops/provider-sdk';
import { createAzureCliProbe, createAzurePlugin } from '@cloudops/provider-azure';
import { createGcpPlugin } from '@cloudops/provider-gcp';
import { join } from 'node:path';
import { API_VERSION, config, azureOrgs, credentialStorePath, dataDir } from './env.js';
import { SystemService } from './modules/system/system.service.js';
import { JobsService } from './modules/system/jobs.service.js';
import { DuplicateResources } from './modules/system/duplicates.js';
import { logger } from './infra/logger.js';
import { prisma } from './infra/prisma.js';
import { TOKENS } from './tokens.js';

import { AuthRepository } from './modules/auth/auth.repository.js';
import { LocalJwtAuthProvider } from './modules/auth/auth.service.js';
import { InventoryRepository } from './modules/inventory/inventory.repository.js';
import { InventoryService } from './modules/inventory/inventory.service.js';
import { ResourceOpsService } from './modules/inventory/resource-ops.service.js';
import { DashboardService } from './modules/dashboard/dashboard.service.js';
import { PriorityService } from './modules/dashboard/priority.service.js';
import { SyncRepository } from './modules/sync/sync.repository.js';
import { SyncService } from './modules/sync/sync.service.js';
import { SyncEngine } from './modules/sync/sync.engine.js';
import { createSyncWorker } from './workers/sync.worker.js';
import { startMaintenance } from './workers/maintenance.worker.js';
import type { Worker } from 'bullmq';
import { FinopsRepository } from './modules/finops/finops.repository.js';
import { FinopsService } from './modules/finops/finops.service.js';
import { FinopsEngine, ROLLUP_DAYS } from './modules/finops/finops.engine.js';
import { FxRates, parseFxRates } from './modules/finops/fx.js';
import { createFinopsWorker } from './workers/finops.worker.js';
import { allQueues, finopsQueue } from './infra/queue.js';
import { incCounter } from './infra/metrics.js';
import { onJobFailure } from './infra/bullmq.js';
import { fastRedis } from './infra/redis.js';
import { TopologyRepository } from './modules/topology/topology.repository.js';
import { TopologyService } from './modules/topology/topology.service.js';
import { WorkRepository } from './modules/work/work.repository.js';
import { WorkService } from './modules/work/work.service.js';
import { ViewsRepository } from './modules/views/views.repository.js';
import { ViewsService } from './modules/views/views.service.js';
import { WorkspacesRepository } from './modules/workspaces/workspaces.repository.js';
import { WorkspacesService } from './modules/workspaces/workspaces.service.js';
import { StandardsRepository } from './modules/standards/standards.repository.js';
import { StandardsService } from './modules/standards/standards.service.js';
import { TagsService } from './modules/tags/tags.service.js';
import { TagJobsService, createTagsWorker } from './modules/tags/tag-jobs.js';
import { AuditService } from './modules/audit/audit.service.js';
import { NotificationService } from './modules/notifications/notifications.service.js';
import { Notifier } from './modules/notifications/notifier.js';
import { AutomationEngine } from './modules/automation/automation.engine.js';
import { AutomationService } from './modules/automation/automation.service.js';
import { SearchService } from './modules/search/search.service.js';
import { DriftService } from './modules/drift/drift.service.js';
import { RemediationService } from './modules/remediation/remediation.service.js';
import { RemediationEngine } from './modules/remediation/remediation.engine.js';
import { isRemediableTemplate } from './modules/remediation/remediation.catalog.js';
import { createRemediationWorker } from './workers/remediation.worker.js';
import { EvaluationJobs, createEvaluationWorker } from './modules/standards/evaluation.jobs.js';
import './domain-events.js';
import { UsersService } from './modules/users/users.service.js';
import {
  ProviderAccountsService,
  type ProviderAccountsDocument,
} from './modules/providers/provider-accounts.service.js';

export interface AppComposition {
  kernel: Kernel;
  registry: ProviderRegistry;
  credentials: CredentialChain;
  providerAccounts: ProviderAccountsService;
  auth: LocalJwtAuthProvider;
  audit: AuditService;
  users: UsersService;
  notifications: NotificationService;
  automation: AutomationService;
  search: SearchService;
  remediation: RemediationService;
  evaluationJobs: EvaluationJobs;
  resourceOps: ResourceOpsService;
  drift: DriftService;
  inventory: InventoryService;
  dashboard: DashboardService;
  sync: SyncService;
  syncEngine: SyncEngine;
  finops: FinopsService;
  finopsEngine: FinopsEngine;
  topology: TopologyService;
  work: WorkService;
  views: ViewsService;
  workspaces: WorkspacesService;
  standards: StandardsService;
  tags: TagsService;
  tagJobs: TagJobsService;
  system: SystemService;
  jobs: JobsService;
  duplicates: DuplicateResources;
  configDir?: string;
}

/**
 * Composition root — the single place concrete implementations are wired to the
 * kernel. Adding a provider or engine is a registration here; nothing else in
 * the core changes.
 */
export async function compose(): Promise<AppComposition> {
  const kernel = createKernel();
  const configDir = config.AZURE_CONFIG_DIR;

  // Cross-cutting singletons.
  kernel.container.registerValue(TOKENS.Prisma, prisma);
  kernel.container.registerValue(TOKENS.Logger, logger);
  kernel.container.registerValue(TOKENS.EventBus, kernel.events);

  // Provider registry (shared token so plugins can register into it).
  const registry = new ProviderRegistry();
  kernel.container.registerValue(PROVIDER_REGISTRY, registry);

  // Provider accounts (organizations) — merged from the local encrypted store
  // (entered in the Providers page) and the environment (AZURE_ORGS). Secrets
  // live on disk in an AES-GCM envelope and in memory; never in Postgres.
  const providerAccounts = new ProviderAccountsService(
    new EncryptedJsonStore<ProviderAccountsDocument>({
      filePath: credentialStorePath,
      key: config.CREDENTIAL_STORE_KEY,
    }),
    azureOrgs,
    logger,
  );
  await providerAccounts.init();
  const azureAccounts = () => providerAccounts.resolve('azure');
  const gcpAccounts = () => providerAccounts.resolve('gcp');

  // Credential chain — secrets resolved at runtime, never persisted.
  // In multi-org mode the Azure provider manages per-tenant service-principal
  // logins itself (from the accounts above, in memory); this signal source just
  // lets the generic engine resolve a credential to proceed.
  const azProbe = createAzureCliProbe(configDir);
  const multiOrgSignal: CredentialProvider = {
    kind: 'env',
    isAvailable: async () => azureAccounts().length > 0 || gcpAccounts().length > 0,
    resolve: async () => ({
      source: 'env',
      metadata: { orgs: String(azureAccounts().length + gcpAccounts().length) },
    }),
  };
  const credentials = new CredentialChain([
    new AzureCliCredentialProvider(azProbe),
    multiOrgSignal,
    new EnvCredentialProvider(),
  ]);
  kernel.container.registerValue(TOKENS.CredentialChain, credentials);

  // Register provider plugins (one line each — zero core changes to add more).
  // Multi-org: one service principal per Entra tenant, all synced together.
  const configuredOrgs = azureAccounts();
  if (configuredOrgs.length > 0) {
    logger.info(`Azure multi-org mode: ${configuredOrgs.length} org(s) configured`, {
      orgs: configuredOrgs.map((o) => o.name),
    });
  } else {
    logger.info(
      'Azure host mode: no service principals configured (add them in Providers, or reuse `az login`)',
    );
  }
  await kernel.plugins.use(
    createAzurePlugin({
      configDir,
      // One isolated Azure CLI profile per org, beside the credential store
      // (private, persistent). Orgs never share a login, so concurrent work
      // across tenants can't cross sessions.
      profilesDir: join(dataDir, 'az-profiles'),
      // A function, not a snapshot: orgs added/edited in the UI apply live.
      accounts: azureAccounts,
      ownerTag: config.AZURE_OWNER_TAG,
      writeEnabled: config.AZURE_ALLOW_WRITE,
    }),
  );
  await kernel.plugins.use(createGcpPlugin(gcpAccounts));

  // Feature services.
  const audit = new AuditService(prisma, logger);
  const authRepo = new AuthRepository(prisma);
  const auth = new LocalJwtAuthProvider(authRepo, audit);
  const users = new UsersService(authRepo, auth, audit);
  const inventoryRepo = new InventoryRepository(prisma);
  const inventory = new InventoryService(inventoryRepo);
  const syncRepo = new SyncRepository(prisma);
  const sync = new SyncService(syncRepo, fastRedis, audit, logger, configDir);
  const syncEngine = new SyncEngine({
    registry,
    credentials,
    repo: syncRepo,
    events: kernel.events,
    logger,
    ownerTag: config.AZURE_OWNER_TAG,
  });

  // FinOps (cost) — engine + service reuse the same registry/credentials.
  const finopsRepo = new FinopsRepository(prisma);
  const finops = new FinopsService(finopsRepo, config.FINOPS_WINDOW_DAYS, audit);
  const jobs = new JobsService(allQueues, audit);
  const system = new SystemService(
    prisma,
    fastRedis,
    allQueues,
    finops,
    API_VERSION,
    jobs,
    registry,
    (key) => providerAccounts.list(key).length,
  );
  const duplicates = new DuplicateResources(prisma, audit, () =>
    finopsRepo.recomputeRollups(ROLLUP_DAYS),
  );
  const fx = new FxRates(config.COST_CURRENCY, parseFxRates(config.COST_FX_RATES), undefined, (m) =>
    logger.warn(m),
  );
  const finopsEngine = new FinopsEngine({
    registry,
    credentials,
    repo: finopsRepo,
    events: kernel.events,
    logger,
    windowDays: config.FINOPS_WINDOW_DAYS,
    fx,
  });

  // Topology (dependency graph) — read-only over the ResourceRelationship edges
  // built during sync. No provider/credential dependency.
  const topology = new TopologyService(new TopologyRepository(prisma), config.COST_CURRENCY);

  // Work management (tasks at any scope) — CRUD over WorkItem + scope links.
  const work = new WorkService(new WorkRepository(prisma), audit, kernel.events);

  // Saved views — named filter sets for the explorer pages.
  const views = new ViewsService(new ViewsRepository(prisma));

  // Resource workspaces — per-scope markdown docs / runbooks / SOPs.
  const workspaces = new WorkspacesService(new WorkspacesRepository(prisma), audit);

  // Standards & governance — rule catalog + compliance evaluation/scoring.
  const standards = new StandardsService(new StandardsRepository(prisma), kernel.events);
  // Compliance stays current: every inventory or cost sync queues an evaluation
  // (cost rules read cost data). Runs in the background, never on a request.
  const evaluationJobs = new EvaluationJobs(logger);
  kernel.events.on('sync.completed', () => evaluationJobs.enqueueQuietly('after inventory sync'));
  kernel.events.on('finops.synced', () => evaluationJobs.enqueueQuietly('after cost sync'));

  // Operations Dashboard — read model that composes standards + work + inventory/cost.
  const priority = new PriorityService(prisma, finops, work, isRemediableTemplate);
  const dashboard = new DashboardService(prisma, standards, work, priority);

  // Notifications — the notifier turns domain events and scheduled checks into
  // inbox entries. Registered here so it runs wherever the events are emitted
  // (API process, or the standalone worker process).
  const notifications = new NotificationService(prisma, logger);
  const notifier = new Notifier(prisma, notifications, finops, logger);
  notifier.register(kernel.events);
  onJobFailure((f) => incCounter('cloudops_jobs_failed_total', { queue: f.queue }));

  // Automation rules: WHEN an event, IF conditions, THEN notify / raise work. Never changes the cloud.
  const automationEngine = new AutomationEngine(prisma, notifications, work, finops, logger);
  automationEngine.register(kernel.events);
  const automation = new AutomationService(prisma, automationEngine, standards, finops, audit);

  // Single-resource operations: refresh from the provider, re-evaluate.
  const resourceOps = new ResourceOpsService(
    prisma,
    registry,
    credentials,
    standards,
    audit,
    logger,
    config.AZURE_OWNER_TAG,
  );

  // Drift explorer (+ who-changed-it from the provider's activity log).
  const drift = new DriftService(prisma, registry, credentials, logger);

  // Global search (command palette).
  const search = new SearchService(prisma);

  // Tag write-back — writes tags to Azure via the provider, gated by AZURE_ALLOW_WRITE.
  const tags = new TagsService(
    prisma,
    registry,
    credentials,
    logger,
    config.AZURE_ALLOW_WRITE,
    audit,
  );
  const tagJobs = new TagJobsService(prisma, config.AZURE_ALLOW_WRITE);

  // Remediation — plan / approve / execute / verify, on top of the provider's
  // `actions` capability and tag write-back. Executes only via its own queue.
  const remediation = new RemediationService({
    prisma,
    registry,
    audit,
    events: kernel.events,
    logger,
    writeEnabled: config.AZURE_ALLOW_WRITE,
    allowSelfApproval: config.REMEDIATION_SELF_APPROVAL,
    ownerTag: config.AZURE_OWNER_TAG,
    inventory: inventoryRepo,
  });
  const remediationEngine = new RemediationEngine({
    prisma,
    registry,
    credentials,
    tags,
    standards,
    audit,
    events: kernel.events,
    logger,
    ownerTag: config.AZURE_OWNER_TAG,
  });

  // Background workers run in-process (single-container laptop deployment).
  // Each registers a stop hook so shutdown waits for in-flight jobs to finish.
  const workers: Worker[] = [];
  kernel.lifecycle.register({
    name: 'queues',
    // Registered first → stopped last, after every worker has drained.
    stop: async () => {
      await Promise.allSettled(allQueues.map((q) => q.close()));
      fastRedis.disconnect();
    },
  });
  kernel.lifecycle.register({
    name: 'sync-worker',
    start: () => {
      workers.push(
        createSyncWorker(syncEngine, logger, (runId, reason) => sync.markJobFailed(runId, reason)),
      );
      logger.info('sync worker started (in-process)');
    },
  });
  kernel.lifecycle.register({
    name: 'evaluation-worker',
    start: () => {
      workers.push(createEvaluationWorker(standards, logger));
      logger.info('evaluation worker started (in-process)');
    },
  });
  kernel.lifecycle.register({
    name: 'remediation-worker',
    start: () => {
      workers.push(
        createRemediationWorker(remediationEngine, logger, async (runId, reason) => {
          await prisma.remediationRun.updateMany({
            where: { id: runId, status: { in: ['queued', 'running'] } },
            data: { status: 'failed', finishedAt: new Date(), error: `Job failed: ${reason}` },
          });
        }),
      );
      logger.info('remediation worker started (in-process)');
    },
  });
  kernel.lifecycle.register({
    name: 'tags-worker',
    start: () => {
      workers.push(createTagsWorker(tags, logger));
      logger.info('tags worker started (in-process)');
    },
  });
  kernel.lifecycle.register({
    name: 'maintenance',
    start: async () => {
      workers.push(
        await startMaintenance(
          {
            purgeSessions: (before) => authRepo.purgeSessions(before),
            reconcileInterruptedRuns: () => sync.reconcileInterruptedRuns(),
            normalizeCostCurrency: () => finopsEngine.normalizeStoredCurrency(),
            recomputeCostRollups: () => finopsRepo.recomputeRollups(ROLLUP_DAYS),
            scheduledChecks: async () => {
              const checks = await notifier.runScheduledChecks();
              return { ...checks, purged: checks.purged + (await automationEngine.purge()) };
            },
            reconcileRemediations: () => remediation.reconcileInterrupted(),
          },
          logger,
        ),
      );
    },
  });
  kernel.lifecycle.register({
    name: 'finops-worker',
    start: async () => {
      workers.push(createFinopsWorker(finopsEngine, logger));
      logger.info('finops worker started (in-process)');
      if (config.FINOPS_DAILY_SYNC) {
        // Repeatable daily cost sync (opt-in). Stable jobId dedupes across boots.
        await finopsQueue.add(
          'cost-sync',
          { providerKey: 'azure', days: config.FINOPS_WINDOW_DAYS },
          { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'daily-cost-sync' },
        );
        logger.info('daily cost sync scheduled');
      }
    },
    stop: async () => {
      // Let active jobs finish (BullMQ waits for them), then release connections.
      await Promise.allSettled(workers.map((w) => w.close()));
    },
  });

  return {
    kernel,
    registry,
    credentials,
    providerAccounts,
    auth,
    audit,
    users,
    notifications,
    automation,
    search,
    remediation,
    evaluationJobs,
    resourceOps,
    drift,
    inventory,
    dashboard,
    sync,
    syncEngine,
    finops,
    finopsEngine,
    topology,
    work,
    views,
    workspaces,
    standards,
    tags,
    tagJobs,
    system,
    jobs,
    duplicates,
    configDir,
  };
}
