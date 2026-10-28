import { Worker, type Job } from 'bullmq';
import type { Logger } from '@cloudops/kernel';
import { guardWorker, inJobContext } from '../infra/bullmq.js';
import { createRedis } from '../infra/redis.js';
import { SYNC_QUEUE, type SyncJobData } from '../infra/queue.js';
import type { SyncEngine } from '../modules/sync/sync.engine.js';

/**
 * Creates the BullMQ worker that runs sync jobs through the SyncEngine.
 * In the skeleton this runs in-process with the API (single container); it can
 * also be started standalone via `workers/main.ts` to scale out.
 */
export function createSyncWorker(
  engine: SyncEngine,
  logger: Logger,
  onJobFailed?: (syncRunId: string, reason: string) => Promise<void>,
): Worker<SyncJobData> {
  const worker = guardWorker(
    new Worker<SyncJobData>(
      SYNC_QUEUE,
      inJobContext(SYNC_QUEUE, async (job: Job<SyncJobData>) => {
        logger.info('processing sync job', { jobId: job.id, syncRunId: job.data.syncRunId });
        return engine.run(job.data);
      }),
      { connection: createRedis(), concurrency: 2 },
    ),
  );

  worker.on('failed', (job, err) => {
    logger.error('sync job failed', { jobId: job?.id, error: err.message });
    // The engine records its own failures; this covers jobs that died outside it
    // (stalled after a crash, lock lost) so the run never stays "running".
    if (job?.data.syncRunId && onJobFailed) {
      onJobFailed(job.data.syncRunId, `Sync job failed: ${err.message}`).catch(() => undefined);
    }
  });

  return worker;
}
