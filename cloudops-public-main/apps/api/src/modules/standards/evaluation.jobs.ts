import { Worker, type Job } from 'bullmq';
import type { EvaluationStatusDto } from '@cloudops/core';
import type { Logger } from '@cloudops/kernel';
import { assertQueueAvailable, guardWorker, inJobContext, withQueueTimeout } from '../../infra/bullmq.js';
import { createRedis } from '../../infra/redis.js';
import { EVALUATION_QUEUE, evaluationQueue, type EvaluationJobData } from '../../infra/queue.js';
import type { StandardsService } from './standards.service.js';

/**
 * Compliance evaluation as a background job: the UI (and every sync) queues
 * one and polls its status, so evaluating a large estate never ties up a
 * request. At most one evaluation waits at a time — asking again while one is
 * queued returns that one.
 */
export class EvaluationJobs {
  constructor(private readonly logger: Logger) {}

  async enqueue(reason: string, requestedBy: string | null = null): Promise<EvaluationStatusDto & { deduplicated: boolean }> {
    await assertQueueAvailable();
    const waiting = await withQueueTimeout(evaluationQueue.getJobs(['waiting', 'delayed']));
    if (waiting.some(Boolean)) return { ...(await this.status()), deduplicated: true };
    await withQueueTimeout(
      evaluationQueue.add('evaluate', { reason, requestedBy }, { removeOnComplete: 20, removeOnFail: 20, attempts: 1 }),
    );
    return { ...(await this.status()), deduplicated: false };
  }

  /** Queue one without failing the caller if Redis is down (sync hooks). */
  async enqueueQuietly(reason: string): Promise<void> {
    try {
      await this.enqueue(reason);
    } catch (err) {
      this.logger.warn('could not queue a compliance evaluation', { reason, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async status(): Promise<EvaluationStatusDto> {
    const jobs = (await withQueueTimeout(evaluationQueue.getJobs(['active', 'waiting', 'delayed', 'completed', 'failed'], 0, 30))).filter(
      (j): j is Job<EvaluationJobData> => Boolean(j),
    );
    const active = jobs.find((j) => j.processedOn && !j.finishedOn);
    const queued = jobs.find((j) => !j.processedOn);
    const last = jobs.filter((j) => j.finishedOn).sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0))[0];
    const current = active ?? queued;
    const result = last?.returnvalue as { score?: number; failed?: number } | undefined;
    return {
      state: active ? 'running' : queued ? 'queued' : 'idle',
      reason: current?.data.reason ?? null,
      queuedAt: current ? new Date(current.timestamp).toISOString() : null,
      startedAt: active?.processedOn ? new Date(active.processedOn).toISOString() : null,
      last: last
        ? {
            finishedAt: new Date(last.finishedOn!).toISOString(),
            durationMs: last.processedOn ? last.finishedOn! - last.processedOn : null,
            ok: !last.failedReason,
            error: last.failedReason ?? null,
            reason: last.data.reason,
            score: result?.score ?? null,
            failed: result?.failed ?? null,
          }
        : null,
    };
  }
}

export function createEvaluationWorker(standards: StandardsService, logger: Logger): Worker<EvaluationJobData> {
  const worker = guardWorker(
    new Worker<EvaluationJobData>(
      EVALUATION_QUEUE,
      inJobContext(EVALUATION_QUEUE, async (job: Job<EvaluationJobData>) => {
        const started = Date.now();
        const summary = await standards.evaluate();
        logger.info('compliance evaluation completed', {
          reason: job.data.reason,
          durationMs: Date.now() - started,
          score: summary.score,
          checks: summary.totalChecks,
          failed: summary.failed,
        });
        return { score: summary.score, failed: summary.failed };
      }),
      { connection: createRedis(), concurrency: 1, lockDuration: 10 * 60_000 },
    ),
  );
  worker.on('failed', (job, err) => logger.error('compliance evaluation failed', { jobId: job?.id, error: err.message }));
  return worker;
}
