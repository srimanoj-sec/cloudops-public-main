import { Queue } from 'bullmq';
import { guardQueue } from './bullmq.js';
import { createRedis } from './redis.js';

export const SYNC_QUEUE = 'sync';
export const FINOPS_QUEUE = 'finops';
export const TAGS_QUEUE = 'tags';
export const MAINTENANCE_QUEUE = 'maintenance';
export const REMEDIATION_QUEUE = 'remediation';
export const EVALUATION_QUEUE = 'evaluation';

/** Singleton BullMQ queue for provider synchronization jobs. */
export const syncQueue = guardQueue(new Queue(SYNC_QUEUE, { connection: createRedis() }));

/** Singleton BullMQ queue for cost (FinOps) sync jobs. */
export const finopsQueue = guardQueue(new Queue(FINOPS_QUEUE, { connection: createRedis() }));

/** Long-running tag write-back (apply to a resource group + all its resources). */
export const tagsQueue = guardQueue(new Queue(TAGS_QUEUE, { connection: createRedis() }));

/** Housekeeping (session purge, interrupted-run recovery) on a schedule. */
export const maintenanceQueue = guardQueue(new Queue(MAINTENANCE_QUEUE, { connection: createRedis() }));

/** Approved remediations (changes to the estate), one run at a time. */
export const remediationQueue = guardQueue(new Queue(REMEDIATION_QUEUE, { connection: createRedis() }));

/** Compliance evaluations (manual, and after every sync). */
export const evaluationQueue = guardQueue(new Queue(EVALUATION_QUEUE, { connection: createRedis() }));

/** Every queue, for graceful shutdown. */
export const allQueues = [syncQueue, finopsQueue, tagsQueue, maintenanceQueue, remediationQueue, evaluationQueue];

export interface EvaluationJobData {
  reason: string;
  requestedBy?: string | null;
}

export interface RemediationJobData {
  runId: string;
}

export interface SyncJobData {
  syncRunId: string;
  providerKey: string;
  subscriptionId?: string;
  configDir?: string;
}

export interface FinopsJobData {
  providerKey: string;
  days?: number;
  /** Retry runs are scoped to the subscriptions that were throttled. */
  subscriptionExternalIds?: string[];
  /** 0 for a user/schedule triggered run; incremented by each auto-retry. */
  retryAttempt?: number;
}

export interface TagJobData {
  resourceGroupId: string;
  tags: Record<string, string>;
  actor: { id?: string | null; name?: string | null } | null;
}
