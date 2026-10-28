/**
 * System status — the on-call view (admin only): is every dependency up, are
 * jobs flowing, is the schema current, and how is this instance configured.
 */

export interface DependencyCheck {
  ok: boolean;
  latencyMs: number;
  /** `timeout` | `unreachable` — the cause itself is in the API log. */
  error?: string;
}

export interface QueueStatus {
  name: string;
  /** `null` when Redis could not be read in time. */
  waiting: number | null;
  active: number | null;
  delayed: number | null;
  failed: number | null;
  /** Worker processes currently connected to this queue (any instance). */
  workers: number | null;
}

export interface LastRunStatus {
  status: string;
  at: string | null;
  error: string | null;
}

export interface SystemStatusDto {
  version: string;
  nodeVersion: string;
  environment: string;
  startedAt: string;
  uptimeSeconds: number;
  checks: { database: DependencyCheck; redis: DependencyCheck };
  migrations: {
    applied: number;
    latest: string | null;
    /** Migration folders shipped with this build but not applied (null if unknown). */
    pending: string[] | null;
  };
  queues: QueueStatus[];
  /** Throughput and health per queue (null entries when Redis couldn't be read in time). */
  queueMetrics: (QueueMetricsDto | null)[];
  /** Registered providers and how their organizations fared on the last sync. */
  providers: {
    key: string;
    displayName: string;
    capabilities: string[];
    organizations: number;
    /** Organizations the last completed sync couldn't reach, with why. */
    unreachable: { account: string; message: string }[];
  }[];
  lastInventorySync: LastRunStatus | null;
  lastCostSync: LastRunStatus | null;
  settings: {
    azureAllowWrite: boolean;
    rateLimitEnabled: boolean;
    trustProxy: string;
    finopsWindowDays: number;
    costCurrency: string;
    finopsDailySync: boolean;
    logLevel: string;
  };
}

// ── Background jobs ────────────────────────────────────────────────

export const JOB_STATES = ['failed', 'active', 'waiting', 'delayed', 'completed'] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobSummaryDto {
  id: string;
  queue: string;
  name: string;
  state: JobState;
  attemptsMade: number;
  maxAttempts: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  failedReason: string | null;
  /** The payload, secret-free and truncated. */
  data: Record<string, string>;
  /** Where to see what it worked on (a sync run, a remediation…). */
  link: string | null;
}

export interface JobDetailDto extends JobSummaryDto {
  /** The last few stack traces (failed jobs). */
  stacktrace: string[];
  returnValue: Record<string, string> | null;
  canRetry: boolean;
  canRemove: boolean;
}

export interface QueueMetricsDto {
  queue: string;
  completedLastHour: number;
  failedLastHour: number;
  /** The hourly figures hit the sample cap (show as “100+”). */
  sampled: boolean;
  /** % of the last hour's finished jobs that failed (null when none finished). */
  failureRate: number | null;
  avgDurationMs: number | null;
  /** How long the oldest waiting job has waited — a stuck queue shows here first. */
  oldestWaitingAgeMs: number | null;
}

// ── Data integrity: duplicate resource rows ────────────────────────

export interface DuplicateGroupDto {
  /** The lower-cased Azure resource id the rows share. */
  key: string;
  /** The row that is kept (active, most recently synced). */
  keep: { id: string; name: string; type: string; state: string; lastSyncedAt: string | null };
  /** Rows merged into it and then removed, with what moves over. */
  remove: {
    id: string;
    name: string;
    state: string;
    externalId: string;
    costRecords: number;
    cost: number;
    changeEvents: number;
  }[];
}

export interface DuplicatePreviewDto {
  groups: DuplicateGroupDto[];
  rowsToRemove: number;
}

export interface DuplicateMergeResultDto {
  groups: number;
  rowsRemoved: number;
}
