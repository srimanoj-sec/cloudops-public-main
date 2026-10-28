import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LastRunStatus, QueueStatus, SyncSummary, SystemStatusDto } from '@cloudops/core';
import type { ProviderRegistry } from '@cloudops/provider-sdk';
import type { JobsService } from './jobs.service.js';
import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { config } from '../../env.js';
import { checkDependencies } from '../../http/health.js';
import { withQueueTimeout } from '../../infra/bullmq.js';
import type { Prisma } from '../../infra/prisma.js';
import type { FinopsService } from '../finops/finops.service.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'prisma',
  'migrations',
);
const startedAt = new Date();

/**
 * The on-call view: dependencies, job queues, schema state and effective
 * settings in one call. Every probe is bounded, so this answers (partially)
 * even while Redis or Postgres is down — which is exactly when it is needed.
 */
export class SystemService {
  constructor(
    private readonly prisma: Prisma,
    private readonly redis: IORedis,
    private readonly queues: Queue[],
    private readonly finops: FinopsService,
    private readonly version: string,
    private readonly jobs: JobsService,
    private readonly registry: ProviderRegistry,
    private readonly organizations: (providerKey: string) => number,
  ) {}

  async status(): Promise<SystemStatusDto> {
    const [
      checks,
      migrations,
      queues,
      queueMetrics,
      lastInventorySync,
      lastCostSync,
      lastCompleted,
    ] = await Promise.all([
      checkDependencies(this.prisma, this.redis),
      this.migrations(),
      Promise.all(this.queues.map((q) => this.queueStatus(q))),
      Promise.all(this.queues.map((q) => this.jobs.metrics(q.name).catch(() => null))),
      this.lastInventorySync(),
      this.lastCostSync(),
      this.prisma.syncRun
        .findFirst({
          where: { status: 'completed' },
          orderBy: { finishedAt: 'desc' },
          select: { summary: true, providerKey: true },
        })
        .catch(() => null),
    ]);
    const unreachable = ((lastCompleted?.summary as SyncSummary | null)?.accountErrors ?? []).slice(
      0,
      20,
    );
    const providers = this.registry.list().map((p) => ({
      key: p.key,
      displayName: p.displayName,
      capabilities: [...p.capabilities],
      organizations: this.organizations(p.key),
      unreachable: lastCompleted?.providerKey === p.key ? unreachable : [],
    }));
    return {
      version: this.version,
      nodeVersion: process.version,
      environment: config.NODE_ENV,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      checks,
      migrations,
      queues,
      queueMetrics,
      providers,
      lastInventorySync,
      lastCostSync,
      settings: {
        azureAllowWrite: config.AZURE_ALLOW_WRITE,
        rateLimitEnabled: config.RATE_LIMIT_ENABLED,
        trustProxy: String(config.TRUST_PROXY),
        finopsWindowDays: config.FINOPS_WINDOW_DAYS,
        costCurrency: config.COST_CURRENCY,
        finopsDailySync: config.FINOPS_DAILY_SYNC,
        logLevel: config.LOG_LEVEL ?? (config.NODE_ENV === 'production' ? 'info' : 'debug'),
      },
    };
  }

  private async queueStatus(queue: Queue): Promise<QueueStatus> {
    try {
      const [counts, workers] = await withQueueTimeout(
        Promise.all([
          queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
          queue.getWorkersCount(),
        ]),
        2_000,
      );
      return {
        name: queue.name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        workers,
      };
    } catch {
      return {
        name: queue.name,
        waiting: null,
        active: null,
        delayed: null,
        failed: null,
        workers: null,
      };
    }
  }

  private async migrations(): Promise<SystemStatusDto['migrations']> {
    let applied: string[] = [];
    try {
      const rows = await this.prisma.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY finished_at, migration_name`;
      applied = rows.map((r) => r.migration_name);
    } catch {
      return { applied: 0, latest: null, pending: null };
    }
    let pending: string[] | null = null;
    try {
      const shipped = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      pending = shipped.filter((m) => !applied.includes(m)).sort();
    } catch {
      pending = null;
    }
    return { applied: applied.length, latest: applied.at(-1) ?? null, pending };
  }

  private async lastInventorySync(): Promise<LastRunStatus | null> {
    try {
      const run = await this.prisma.syncRun.findFirst({ orderBy: { createdAt: 'desc' } });
      return run
        ? {
            status: run.status,
            at: (run.finishedAt ?? run.createdAt).toISOString(),
            error: run.error,
          }
        : null;
    } catch {
      return null;
    }
  }

  private async lastCostSync(): Promise<LastRunStatus | null> {
    try {
      const [run] = await this.finops.recentSyncs(1);
      return run
        ? {
            status: run.status,
            at: run.finishedAt ?? run.startedAt ?? run.queuedAt,
            error: run.error,
          }
        : null;
    } catch {
      return null;
    }
  }
}
