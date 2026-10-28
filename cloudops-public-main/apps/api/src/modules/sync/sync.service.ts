import type IORedis from 'ioredis';
import type { SyncRunChangeDto, SyncRunDto, SyncRunsQuery, SyncSummary } from '@cloudops/core';
import type { Logger } from '@cloudops/kernel';
import { AppError } from '../../http/errors.js';
import { assertQueueAvailable, withQueueTimeout } from '../../infra/bullmq.js';
import { syncQueue, type SyncJobData } from '../../infra/queue.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import type { SyncRepository } from './sync.repository.js';

type SyncRunRow = {
  id: string;
  providerKey: string;
  status: string;
  scope: string | null;
  triggeredBy?: string | null;
  created: number;
  updated: number;
  changes: number;
  deleted: number;
  error: string | null;
  summary: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};

function toDto(r: SyncRunRow): SyncRunDto {
  return {
    id: r.id,
    providerKey: r.providerKey,
    status: r.status,
    scope: r.scope,
    created: r.created,
    updated: r.updated,
    changes: r.changes,
    deleted: r.deleted,
    error: r.error,
    summary: (r.summary as SyncSummary | null) ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    triggeredBy: r.triggeredBy ?? null,
    durationMs: r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
  };
}

/** Job states in which a run is genuinely still in progress. */
const LIVE_JOB_STATES = new Set(['active', 'waiting', 'delayed', 'waiting-children', 'prioritized']);
const INTERRUPTED = 'Interrupted — the worker stopped before this run finished (API restart or crash). Run the sync again.';

export class SyncService {
  constructor(
    private readonly repo: SyncRepository,
    private readonly lockRedis: IORedis,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    private readonly configDir?: string,
  ) {}

  /**
   * Create a SyncRun and enqueue the background job. Returns immediately.
   *
   * Idempotent per provider+scope: if a run is already queued or running (and
   * its job is alive) that run is returned with `deduplicated: true` instead of
   * starting a second, concurrent sync of the same estate.
   */
  async enqueue(input: { providerKey: string; subscriptionId?: string }, actor?: AuditActor | null): Promise<SyncRunDto> {
    await assertQueueAvailable(); // fail fast (503) rather than create a run that can't be queued
    const lockKey = `cloudops:lock:sync-enqueue:${input.providerKey}:${input.subscriptionId ?? '*'}`;
    const locked = await this.lockRedis.set(lockKey, '1', 'PX', 5_000, 'NX').catch(() => 'OK');
    if (!locked) {
      // A concurrent request is creating the run right now — return it.
      await new Promise((r) => setTimeout(r, 300));
      const active = await this.repo.activeRun(input.providerKey, input.subscriptionId);
      if (active) return { ...toDto(active as SyncRunRow), deduplicated: true };
    }
    try {
      const active = await this.repo.activeRun(input.providerKey, input.subscriptionId);
      if (active) {
        if (await this.isLive(active.id)) return { ...toDto(active as SyncRunRow), deduplicated: true };
        await this.repo.failIfUnfinished(active.id, INTERRUPTED);
      }

      const run = await this.repo.createRun({ providerKey: input.providerKey, scope: input.subscriptionId, triggeredBy: actor?.name ?? null });
      const data: SyncJobData = {
        syncRunId: run.id,
        providerKey: input.providerKey,
        subscriptionId: input.subscriptionId,
        configDir: this.configDir,
      };
      // jobId = run id, so a run can always be matched to its queue job.
      try {
        await withQueueTimeout(
          syncQueue.add('sync', data, { jobId: run.id, removeOnComplete: 100, removeOnFail: 100, attempts: 1 }),
        );
      } catch (err) {
        await this.repo.failIfUnfinished(run.id, 'Could not be queued — the job queue (Redis) was unavailable');
        throw err;
      }
      await this.audit.record({
        action: 'sync.enqueue',
        entity: 'syncRun',
        entityId: run.id,
        actor,
        metadata: { providerKey: input.providerKey, scope: input.subscriptionId ?? 'all' },
      });
      return toDto(run as SyncRunRow);
    } finally {
      await this.lockRedis.del(lockKey).catch(() => undefined);
    }
  }

  private async isLive(runId: string): Promise<boolean> {
    const job = await withQueueTimeout(syncQueue.getJob(runId));
    if (!job) return false;
    return LIVE_JOB_STATES.has(await job.getState());
  }

  /**
   * Crash/restart recovery: runs left `queued`/`running` whose job is no longer
   * alive (the process died mid-sync) are marked failed so the UI never shows a
   * sync "running" forever. Only runs older than `graceMs` are considered.
   */
  async reconcileInterruptedRuns(graceMs = 120_000): Promise<number> {
    const stale = await this.repo.unfinishedRuns(new Date(Date.now() - graceMs));
    let fixed = 0;
    for (const run of stale) {
      if (await this.isLive(run.id)) continue;
      const r = await this.repo.failIfUnfinished(run.id, INTERRUPTED);
      fixed += r.count;
    }
    if (fixed) this.logger.warn(`marked ${fixed} interrupted sync run(s) as failed`);
    return fixed;
  }

  /** Called when a queue job fails outside the engine (stalled, crashed worker). */
  async markJobFailed(syncRunId: string, reason: string): Promise<void> {
    await this.repo.failIfUnfinished(syncRunId, reason);
  }

  async listRuns(q: Partial<SyncRunsQuery> = {}): Promise<SyncRunDto[]> {
    const runs = await this.repo.listRuns(q.limit ?? 20, q.status, q.before);
    return runs.map((r) => toDto(r as SyncRunRow));
  }

  async getRun(id: string): Promise<SyncRunDto> {
    const run = await this.repo.findRun(id);
    if (!run) throw AppError.notFound('Sync run not found');
    return toDto(run as SyncRunRow);
  }

  /** Cancel a sync that hasn't started. A running sync finishes (it can't be stopped mid-write safely). */
  async cancel(id: string, actor?: AuditActor | null): Promise<SyncRunDto> {
    const run = await this.repo.findRun(id);
    if (!run) throw AppError.notFound('Sync run not found');
    if (run.status !== 'queued') throw AppError.conflict(run.status === 'running' ? 'It is already running — it will finish on its own.' : `This run is ${run.status}.`);
    const job = await withQueueTimeout(syncQueue.getJob(id)).catch(() => undefined);
    const state = await job?.getState().catch(() => undefined);
    if (state === 'active') throw AppError.conflict('It just started running — it will finish on its own.');
    await job?.remove().catch(() => undefined);
    await this.repo.failIfUnfinished(id, `Cancelled by ${actor?.name ?? 'a user'} before it started`);
    await this.audit.record({ action: 'sync.cancel', entity: 'syncRun', entityId: id, actor });
    return this.getRun(id);
  }

  /** The field-level changes a single sync run detected — the "what changed" drilldown. */
  async runChanges(id: string): Promise<SyncRunChangeDto[]> {
    const run = await this.repo.findRun(id);
    if (!run) throw AppError.notFound('Sync run not found');
    const rows = await this.repo.changesForRun(id);
    return rows.map((c) => ({
      id: c.id,
      resourceId: c.resource?.id ?? c.resourceId,
      resourceName: c.resource?.name ?? null,
      resourceType: c.resource?.type ?? null,
      field: c.field,
      oldValue: c.oldValue,
      newValue: c.newValue,
      detectedAt: c.detectedAt.toISOString(),
    }));
  }
}
