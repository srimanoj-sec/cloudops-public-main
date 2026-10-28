import type { Job, Queue } from 'bullmq';
import type { JobDetailDto, JobState, JobSummaryDto, QueueMetricsDto } from '@cloudops/core';
import { AppError } from '../../http/errors.js';
import { assertQueueAvailable, withQueueTimeout } from '../../infra/bullmq.js';
import { redact } from '../../infra/logger.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';

const HOUR_MS = 3_600_000;
/**
 * Newest jobs per state read for the hourly figures. Status refreshes every 15 s while
 * open, and job records can be large (cost-sync results), so the sample is bounded:
 * a busier hour reports "100+" (`sampled`).
 */
const METRIC_SAMPLE = 100;
/** Job payload keys never shown (internal paths). Secret-looking keys are redacted too. */
const HIDDEN_KEYS = new Set(['configDir']);

/** A one-line, secret-free view of a job's payload. */
function summarize(data: unknown): Record<string, string> {
  const clean = redact(data) as Record<string, unknown> | null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(clean ?? {})) {
    if (HIDDEN_KEYS.has(k) || v === undefined || v === null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    out[k] = s.length > 200 ? `${s.slice(0, 197)}…` : s;
  }
  return out;
}

/** Where to see what a job was working on. */
function relatedLink(queue: string, data: Record<string, unknown>): string | null {
  if (queue === 'sync' && typeof data.syncRunId === 'string')
    return `/operations/syncs?run=${data.syncRunId}`;
  if (queue === 'remediation' && typeof data.runId === 'string')
    return `/remediation/${data.runId}`;
  if (queue === 'finops') return '/finops?tab=sync';
  if (queue === 'evaluation') return '/standards';
  if (queue === 'tags' && typeof data.resourceGroupId === 'string')
    return `/inventory?resourceGroupId=${data.resourceGroupId}`;
  return null;
}

async function stateOf(job: Job): Promise<JobState> {
  const s = await job.getState();
  return (
    ['waiting', 'active', 'delayed', 'completed', 'failed'].includes(s) ? s : 'waiting'
  ) as JobState;
}

function summaryDto(queue: string, job: Job, state: JobState): JobSummaryDto {
  const data = (job.data ?? {}) as Record<string, unknown>;
  return {
    id: String(job.id),
    queue,
    name: job.name,
    state,
    attemptsMade: job.attemptsMade,
    maxAttempts: Math.max(1, job.opts.attempts ?? 1),
    queuedAt: new Date(job.timestamp).toISOString(),
    startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    durationMs: job.processedOn && job.finishedOn ? job.finishedOn - job.processedOn : null,
    failedReason: job.failedReason ? job.failedReason.slice(0, 500) : null,
    data: summarize(data),
    link: relatedLink(queue, data),
  };
}

/**
 * Background job monitoring for the operations console: throughput and
 * failures per queue, job lists, job detail, and the safe interventions —
 * retry a failed job, remove one that isn't running. Remediation jobs are not
 * retried from here: a change to the estate is re-requested (and re-approved).
 */
export class JobsService {
  constructor(
    private readonly queues: Queue[],
    private readonly audit: AuditService,
  ) {}

  private queue(name: string): Queue {
    const q = this.queues.find((x) => x.name === name);
    if (!q) throw AppError.notFound(`No queue named ${name}`);
    return q;
  }

  async metrics(name: string): Promise<QueueMetricsDto> {
    const q = this.queue(name);
    const now = Date.now();
    const [completed, failed, waiting] = await withQueueTimeout(
      Promise.all([
        q.getJobs(['completed'], 0, METRIC_SAMPLE - 1),
        q.getJobs(['failed'], 0, METRIC_SAMPLE - 1),
        // Oldest waiting job only (ascending order → index 0), not the whole wait list.
        q.getJobs(['waiting'], 0, 0, true),
      ]),
      3_000,
    );
    const recent = (jobs: (Job | undefined)[]) =>
      jobs.filter((j): j is Job => Boolean(j?.finishedOn && j.finishedOn > now - HOUR_MS));
    const doneHour = recent(completed).length;
    const failedHour = recent(failed).length;
    const durations = recent(completed)
      .map((j) => (j.processedOn && j.finishedOn ? j.finishedOn - j.processedOn : null))
      .filter((d): d is number => d !== null);
    const oldest = waiting
      .filter((j): j is Job => Boolean(j))
      .reduce((min, j) => Math.min(min, j.timestamp), Infinity);
    return {
      queue: name,
      completedLastHour: doneHour,
      failedLastHour: failedHour,
      failureRate:
        doneHour + failedHour > 0 ? Math.round((failedHour / (doneHour + failedHour)) * 100) : null,
      sampled: completed.length >= METRIC_SAMPLE || failed.length >= METRIC_SAMPLE,
      avgDurationMs: durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null,
      oldestWaitingAgeMs: Number.isFinite(oldest) ? now - oldest : null,
    };
  }

  async list(name: string, state: JobState, limit = 50): Promise<JobSummaryDto[]> {
    await assertQueueAvailable();
    const q = this.queue(name);
    const jobs = (await withQueueTimeout(q.getJobs([state], 0, limit - 1))).filter((j): j is Job =>
      Boolean(j),
    );
    return jobs.map((j) => summaryDto(name, j, state));
  }

  async get(name: string, id: string): Promise<JobDetailDto> {
    await assertQueueAvailable();
    const job = await withQueueTimeout(this.queue(name).getJob(id));
    if (!job)
      throw AppError.notFound(
        'Job not found — completed and failed jobs are only kept for a while.',
      );
    const state = await stateOf(job);
    return {
      ...summaryDto(name, job, state),
      stacktrace: (job.stacktrace ?? [])
        .slice(-3)
        .map((s) => s.split('\n').slice(0, 12).join('\n')),
      returnValue:
        job.returnvalue === undefined
          ? null
          : summarize(
              typeof job.returnvalue === 'object' ? job.returnvalue : { value: job.returnvalue },
            ),
      canRetry: state === 'failed' && name !== 'remediation',
      canRemove: state !== 'active',
    };
  }

  async retry(name: string, id: string, actor: AuditActor | null): Promise<JobDetailDto> {
    if (name === 'remediation')
      throw AppError.badRequest(
        'Remediations aren’t retried from here — request the change again so it is re-planned and re-approved.',
      );
    await assertQueueAvailable();
    const job = await withQueueTimeout(this.queue(name).getJob(id));
    if (!job) throw AppError.notFound('Job not found');
    if ((await job.getState()) !== 'failed')
      throw AppError.conflict('Only failed jobs can be retried.');
    await job.retry('failed');
    await this.audit.record({
      action: 'job.retry',
      entity: 'job',
      entityId: `${name}:${id}`,
      actor,
      metadata: { queue: name, name: job.name },
    });
    return this.get(name, id);
  }

  async remove(name: string, id: string, actor: AuditActor | null): Promise<void> {
    await assertQueueAvailable();
    const job = await withQueueTimeout(this.queue(name).getJob(id));
    if (!job) throw AppError.notFound('Job not found');
    if ((await job.getState()) === 'active')
      throw AppError.conflict('A running job can’t be removed — let it finish.');
    await job.remove();
    await this.audit.record({
      action: 'job.remove',
      entity: 'job',
      entityId: `${name}:${id}`,
      actor,
      metadata: { queue: name, name: job.name },
    });
  }
}
