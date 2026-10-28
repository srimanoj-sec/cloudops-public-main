/**
 * Scheduler abstraction.
 *
 * The kernel defines the contract; the concrete implementation (BullMQ repeatable
 * jobs) lives in the api infrastructure layer so the kernel stays dependency-free.
 * Recurring work (syncs, reviews, scoring) schedules through this interface.
 */

export interface ScheduleOptions {
  /** Cron expression or ISO-8601 repeat interval. */
  cron?: string;
  everyMs?: number;
  /** Stable id so re-scheduling replaces rather than duplicates. */
  jobId: string;
}

export interface Scheduler {
  schedule<T>(queue: string, payload: T, options: ScheduleOptions): Promise<void>;
  enqueue<T>(queue: string, payload: T): Promise<string>;
  removeSchedule(queue: string, jobId: string): Promise<void>;
}
