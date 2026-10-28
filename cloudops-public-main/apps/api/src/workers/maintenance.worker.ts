import { Worker, type Job } from 'bullmq';
import type { Logger } from '@cloudops/kernel';
import { guardWorker, inJobContext } from '../infra/bullmq.js';
import { createRedis } from '../infra/redis.js';
import { MAINTENANCE_QUEUE, maintenanceQueue } from '../infra/queue.js';

export interface MaintenanceTasks {
  /** Delete sessions that expired / were revoked before the cutoff. */
  purgeSessions: (before: Date) => Promise<number>;
  /** Fail sync runs whose worker died mid-run. */
  reconcileInterruptedRuns: () => Promise<number>;
  /**
   * Re-derive per-resource cost figures from the stored cost records (SQL
   * only, no Azure call). Run at boot so a changed rollup rule — or an
   * upgrade — shows correct numbers immediately, not after the next cost sync.
   */
  recomputeCostRollups: () => Promise<number>;
  /** Convert stored cost still in a non-reporting currency (SQL + a cached FX lookup). */
  normalizeCostCurrency: () => Promise<number>;
  /** Fail remediation runs whose worker died mid-run. */
  reconcileRemediations?: () => Promise<number>;
  /** Reminders (due work, expiring exemptions) and notification retention. */
  scheduledChecks?: () => Promise<{ reminders: number; purged: number }>;
}

/** Keep expired/revoked refresh sessions this long (useful for investigating). */
const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EVERY_MS = 15 * 60 * 1000;
const BOOT_JOB = 'housekeeping-boot';

/**
 * Scheduled housekeeping: runs once at startup and every 15 minutes. A single
 * repeatable job (stable id) so multiple API instances don't multiply the work.
 */
export async function startMaintenance(tasks: MaintenanceTasks, logger: Logger): Promise<Worker> {
  const worker = guardWorker(new Worker(
    MAINTENANCE_QUEUE,
    inJobContext(MAINTENANCE_QUEUE, async (job: Job) => {
      const purged = await tasks.purgeSessions(new Date(Date.now() - SESSION_RETENTION_MS));
      const interrupted = (await tasks.reconcileInterruptedRuns()) + ((await tasks.reconcileRemediations?.()) ?? 0);
      const checks = (await tasks.scheduledChecks?.()) ?? { reminders: 0, purged: 0 };
      let converted = 0;
      let rolledUp = 0;
      if (job.name === BOOT_JOB) {
        // Order matters: convert currencies first, then re-derive the rollups from them.
        converted = await tasks.normalizeCostCurrency();
        rolledUp = await tasks.recomputeCostRollups();
      }
      if (purged || interrupted || rolledUp || converted || checks.purged) {
        logger.info('maintenance completed', {
          purgedSessions: purged,
          interruptedRuns: interrupted,
          costRowsConverted: converted,
          costRollups: rolledUp,
          notificationsPurged: checks.purged,
        });
      }
      return { purged, interrupted, converted, rolledUp, reminders: checks.reminders };
    }),
    { connection: createRedis(), concurrency: 1 },
  ));
  worker.on('failed', (_job, err) => logger.warn('maintenance job failed', { error: err.message }));

  await maintenanceQueue.add('housekeeping', {}, { repeat: { every: EVERY_MS }, jobId: 'housekeeping', removeOnComplete: 10, removeOnFail: 10 });
  await maintenanceQueue.add(BOOT_JOB, {}, { removeOnComplete: 10, removeOnFail: 10 });
  return worker;
}
