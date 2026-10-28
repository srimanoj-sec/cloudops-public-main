import { Worker, type Job } from 'bullmq';
import type { Logger } from '@cloudops/kernel';
import { guardWorker, inJobContext } from '../infra/bullmq.js';
import { createRedis } from '../infra/redis.js';
import { REMEDIATION_QUEUE, type RemediationJobData } from '../infra/queue.js';
import type { RemediationEngine } from '../modules/remediation/remediation.engine.js';

/**
 * Runs approved remediations. Concurrency 1: changes to the estate happen one
 * run at a time, and each run applies its targets sequentially.
 */
export function createRemediationWorker(
  engine: RemediationEngine,
  logger: Logger,
  onJobFailed: (runId: string, reason: string) => Promise<void>,
): Worker<RemediationJobData> {
  const worker = guardWorker(
    new Worker<RemediationJobData>(
      REMEDIATION_QUEUE,
      inJobContext(REMEDIATION_QUEUE, async (job: Job<RemediationJobData>) => {
        logger.info('processing remediation job', { jobId: job.id, runId: job.data.runId });
        await engine.run(job.data.runId);
      }),
      // Long-running changes (VM deallocate, deletes): keep the lock long enough.
      { connection: createRedis(), concurrency: 1, lockDuration: 5 * 60_000 },
    ),
  );
  worker.on('failed', (job, err) => {
    logger.error('remediation job failed', { jobId: job?.id, error: err.message });
    if (job?.data.runId) onJobFailed(job.data.runId, err.message).catch(() => undefined);
  });
  return worker;
}
