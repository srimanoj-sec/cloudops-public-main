import { Worker, type Job } from 'bullmq';
import type { Logger } from '@cloudops/kernel';
import type { ResourceGroupTagResult, TagJobDto } from '@cloudops/core';
import { AppError } from '../../http/errors.js';
import type { Prisma } from '../../infra/prisma.js';
import { assertQueueAvailable, guardWorker, inJobContext, withQueueTimeout } from '../../infra/bullmq.js';
import { createRedis } from '../../infra/redis.js';
import { TAGS_QUEUE, tagsQueue, type TagJobData } from '../../infra/queue.js';
import type { AuditActor } from '../audit/audit.service.js';
import type { TagsService } from './tags.service.js';

type Progress = { done: number; total: number };

const STATE_MAP: Record<string, TagJobDto['state']> = {
  waiting: 'queued',
  delayed: 'queued',
  prioritized: 'queued',
  'waiting-children': 'queued',
  active: 'running',
  completed: 'completed',
  failed: 'failed',
};

async function toDto(job: Job<TagJobData, ResourceGroupTagResult>): Promise<TagJobDto> {
  const state = STATE_MAP[await job.getState()] ?? 'queued';
  const progress = (typeof job.progress === 'object' ? job.progress : null) as Progress | null;
  return {
    id: job.id!,
    resourceGroupId: job.data.resourceGroupId,
    state,
    progress: progress ?? { done: 0, total: 0 },
    result: state === 'completed' ? (job.returnvalue ?? null) : null,
    error: state === 'failed' ? (job.failedReason ?? 'Tag job failed') : null,
    createdAt: new Date(job.timestamp).toISOString(),
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}

/**
 * Background tag write-back for a whole resource group. Tagging N resources is
 * N sequential Azure calls (seconds each) — far too long for one HTTP request —
 * so it runs as a queued job with live progress the UI can poll.
 */
export class TagJobsService {
  constructor(
    private readonly prisma: Prisma,
    private readonly writeEnabled: boolean,
  ) {}

  async enqueue(resourceGroupId: string, tags: Record<string, string>, actor: AuditActor | null): Promise<TagJobDto> {
    if (!this.writeEnabled) {
      throw AppError.forbidden('Azure write-back is disabled. Set AZURE_ALLOW_WRITE=true to enable tag writes.');
    }
    const rg = await this.prisma.resourceGroup.findFirst({
      where: { OR: [{ id: resourceGroupId }, { externalId: resourceGroupId }] },
      select: { id: true },
    });
    if (!rg) throw AppError.notFound('Resource group not found');

    // One job per resource group at a time — a second request returns the first.
    await assertQueueAvailable();
    const pending = await withQueueTimeout(tagsQueue.getJobs(['active', 'waiting']));
    const existing = pending.find((j) => j?.data.resourceGroupId === rg.id);
    if (existing) return { ...(await toDto(existing)), deduplicated: true };

    const job = await withQueueTimeout(tagsQueue.add(
      'rg-tags',
      { resourceGroupId: rg.id, tags, actor },
      { attempts: 1, removeOnComplete: { age: 24 * 3600, count: 200 }, removeOnFail: { age: 7 * 24 * 3600 } },
    ));
    return toDto(job);
  }

  async get(jobId: string): Promise<TagJobDto> {
    await assertQueueAvailable();
    const job = await withQueueTimeout(tagsQueue.getJob(jobId));
    if (!job) throw AppError.notFound('Tag job not found (it may have expired)');
    return toDto(job);
  }
}

/** Runs tag jobs one at a time (Azure writes stay sequential, as before). */
export function createTagsWorker(tags: TagsService, logger: Logger): Worker<TagJobData, ResourceGroupTagResult> {
  const worker = guardWorker(new Worker<TagJobData, ResourceGroupTagResult>(
    TAGS_QUEUE,
    inJobContext(TAGS_QUEUE, async (job: Job<TagJobData>) => {
      logger.info('processing tag job', { jobId: job.id, resourceGroupId: job.data.resourceGroupId });
      let last = 0;
      return tags.applyResourceGroupTags(job.data.resourceGroupId, job.data.tags, job.data.actor, async (done, total) => {
        // Throttle progress writes to Redis to ~4/s.
        if (done !== total && Date.now() - last < 250) return;
        last = Date.now();
        await job.updateProgress({ done, total } satisfies Progress);
      });
    }),
    { connection: createRedis(), concurrency: 1 },
  ));
  worker.on('failed', (job, err) => logger.error('tag job failed', { jobId: job?.id, error: err.message }));
  return worker;
}
