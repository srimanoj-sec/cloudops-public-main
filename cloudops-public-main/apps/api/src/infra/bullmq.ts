import type { Job, Queue, Worker } from 'bullmq';
import { AppError } from '../http/errors.js';
import { fastRedis, reportConnectionError } from './redis.js';
import { runWithContext } from './request-context.js';

/**
 * BullMQ queues and workers emit 'error' (lost Redis connection, failed
 * blocking read, …). Without a listener BullMQ prints every occurrence as a raw
 * multi-line stack to stderr — thousands of lines a minute while Redis is
 * down. Route them through the throttled connection-error reporter instead.
 */
export function guardQueue<T extends Queue>(queue: T): T {
  queue.on('error', (err) => reportConnectionError(`queue ${queue.name}`, err));
  return queue;
}

/** A job that failed for good (no attempts left). */
export interface JobFailure {
  queue: string;
  jobId: string;
  name: string;
  error: string;
  attemptsMade: number;
}

const jobFailureListeners: ((failure: JobFailure) => void)[] = [];

/** Be told about every job that fails for good (the notifier, metrics). */
export function onJobFailure(listener: (failure: JobFailure) => void): void {
  jobFailureListeners.push(listener);
}

export function guardWorker<T extends Worker>(worker: T): T {
  worker.on('error', (err) => reportConnectionError(`worker ${worker.name}`, err));
  worker.on('failed', (job, err) => {
    if (!job || !jobFailureListeners.length) return;
    // Only the final attempt: a job that will be retried hasn't failed yet.
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const failure: JobFailure = {
      queue: worker.name,
      jobId: String(job.id ?? ''),
      name: job.name,
      error: (err?.message ?? 'unknown error').slice(0, 500),
      attemptsMade: job.attemptsMade,
    };
    for (const listener of jobFailureListeners) {
      try {
        listener(failure);
      } catch {
        // A listener's failure must not affect the worker or the other listeners.
      }
    }
  });
  return worker;
}

/**
 * Run a job processor inside a log context: every line the job writes (engine,
 * provider, audit) carries `requestId: job:<queue>:<id>`, so one grep finds a
 * whole sync/cost/tag run.
 */
export function inJobContext<D, R>(
  queue: string,
  fn: (job: Job<D>) => Promise<R>,
): (job: Job<D>) => Promise<R> {
  return (job) =>
    runWithContext({ requestId: `job:${queue}:${job.id ?? 'unknown'}` }, () => fn(job));
}

const QUEUE_UNAVAILABLE =
  'Background jobs are unavailable right now (Redis is not reachable). Try again shortly.';

/**
 * Request-path guard before touching a queue. Queue connections wait for Redis
 * indefinitely (BullMQ needs that for workers), so an HTTP request that enqueues
 * during an outage would hang. The fast-fail client answers immediately.
 */
export async function assertQueueAvailable(): Promise<void> {
  try {
    await fastRedis.ping();
  } catch {
    throw AppError.unavailable(QUEUE_UNAVAILABLE);
  }
}

/** Bound a request-path queue read (job lists/status) so it can't hang a request. */
export async function withQueueTimeout<T>(op: Promise<T>, timeoutMs = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      op,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(AppError.unavailable(QUEUE_UNAVAILABLE)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
