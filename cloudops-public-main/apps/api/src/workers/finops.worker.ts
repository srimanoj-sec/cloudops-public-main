import { Worker, type Job } from 'bullmq';
import type { Logger } from '@cloudops/kernel';
import { guardWorker, inJobContext } from '../infra/bullmq.js';
import { createRedis } from '../infra/redis.js';
import { FINOPS_QUEUE, finopsQueue, type FinopsJobData } from '../infra/queue.js';
import type { FinopsEngine } from '../modules/finops/finops.engine.js';

/** How long to wait before re-pulling subscriptions that were throttled or unreachable. */
const RETRY_DELAY_MS = 5 * 60 * 1000;
/** Give up after this many automatic retries, so a hard limit cannot loop. */
const MAX_RETRIES = 3;

/**
 * BullMQ worker that runs cost-sync jobs through the FinopsEngine. Runs
 * in-process with the API in the single-container deployment.
 *
 * Subscriptions whose query failed transiently (Azure throttled it, or the
 * network dropped) are not lost: the worker queues a delayed follow-up job
 * scoped to just those subscriptions, up to {@link MAX_RETRIES} times, so the
 * window fills in without replaying the whole estate.
 */
export function createFinopsWorker(engine: FinopsEngine, logger: Logger): Worker<FinopsJobData> {
  const worker = guardWorker(new Worker<FinopsJobData>(
    FINOPS_QUEUE,
    inJobContext(FINOPS_QUEUE, async (job: Job<FinopsJobData>) => {
      logger.info('processing cost-sync job', { jobId: job.id, providerKey: job.data.providerKey });
      const result = await engine.run(job.data);

      const attempt = job.data.retryAttempt ?? 0;
      const retry = result.retry;
      if (retry.length > 0 && attempt < MAX_RETRIES) {
        await finopsQueue.add(
          'cost-sync-retry',
          {
            providerKey: job.data.providerKey,
            days: job.data.days,
            subscriptionExternalIds: retry,
            retryAttempt: attempt + 1,
          },
          { delay: RETRY_DELAY_MS, removeOnComplete: 50, removeOnFail: 50, attempts: 1 },
        );
        logger.warn('cost-sync: scheduled a retry for throttled/unreachable subscriptions', {
          jobId: job.id,
          subscriptions: retry.length,
          retryAttempt: attempt + 1,
          delayMs: RETRY_DELAY_MS,
        });
      } else if (retry.length > 0) {
        logger.error('cost-sync: subscriptions still throttled/unreachable after max retries', {
          jobId: job.id,
          subscriptions: retry,
        });
      }
      return result;
    }),
    { connection: createRedis(), concurrency: 1 },
  ));

  worker.on('failed', (job, err) => {
    logger.error('cost-sync job failed', { jobId: job?.id, error: err.message });
  });

  return worker;
}
