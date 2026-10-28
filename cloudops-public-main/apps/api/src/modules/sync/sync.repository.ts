import { Prisma as PrismaNS } from '@prisma/client';
import type { SyncStatus } from '@cloudops/core';
import type { Scope } from '@cloudops/provider-sdk';
import type { Prisma } from '../../infra/prisma.js';

/** Postgres parameter limit headroom for `IN (...)` lists. */
const CHUNK = 1000;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Columns the reconciler compares — never the (large) `properties` blob. */
const reconcileSelect = {
  id: true,
  externalId: true,
  name: true,
  type: true,
  location: true,
  sku: true,
  owner: true,
  tags: true,
  platformTags: true,
  azureCreatedAt: true,
  state: true,
  propertiesHash: true,
  lastSyncedAt: true,
} as const;

export type ReconcileRow = PrismaNS.ResourceGetPayload<{ select: typeof reconcileSelect }>;

/** Of two rows for the same resource: the active one, else the most recently synced. */
function preferred(a: ReconcileRow, b: ReconcileRow): boolean {
  if (a.state !== b.state) return a.state === 'active';
  return (a.lastSyncedAt?.getTime() ?? 0) > (b.lastSyncedAt?.getTime() ?? 0);
}

/** Data-access for the sync engine: SyncRun lifecycle + scope/resource upserts. */
export class SyncRepository {
  constructor(private readonly prisma: Prisma) {}

  createRun(input: { providerKey: string; scope?: string; triggeredBy?: string | null }) {
    return this.prisma.syncRun.create({
      data: { providerKey: input.providerKey, scope: input.scope, status: 'queued', triggeredBy: input.triggeredBy ?? null },
    });
  }

  /** Newest queued/running run for a provider (+ scope), if any. */
  activeRun(providerKey: string, scope?: string) {
    return this.prisma.syncRun.findFirst({
      where: { providerKey, scope: scope ?? null, status: { in: ['queued', 'running'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Every run still marked queued/running and created before `before`. */
  unfinishedRuns(before: Date) {
    return this.prisma.syncRun.findMany({
      where: { status: { in: ['queued', 'running'] }, createdAt: { lt: before } },
    });
  }

  markRunning(id: string) {
    return this.prisma.syncRun.update({
      where: { id },
      data: { status: 'running', startedAt: new Date() },
    });
  }

  finishRun(
    id: string,
    status: Extract<SyncStatus, 'completed' | 'failed'>,
    counts: { created: number; updated: number; changes: number; deleted?: number },
    error?: string,
    summary?: unknown,
  ) {
    return this.prisma.syncRun.update({
      where: { id },
      data: {
        status,
        finishedAt: new Date(),
        error: error ?? null,
        ...(summary !== undefined ? { summary: summary as object } : {}),
        ...counts,
      },
    });
  }

  /** Fail a run only if it hasn't finished — used by crash/stall recovery. */
  failIfUnfinished(id: string, error: string) {
    return this.prisma.syncRun.updateMany({
      where: { id, status: { in: ['queued', 'running'] } },
      data: { status: 'failed', finishedAt: new Date(), error },
    });
  }

  async listRuns(take = 20, status?: SyncStatus, before?: string) {
    const cursor = before ? await this.prisma.syncRun.findUnique({ where: { id: before }, select: { createdAt: true } }) : null;
    return this.prisma.syncRun.findMany({
      where: { ...(status ? { status } : {}), ...(cursor ? { createdAt: { lt: cursor.createdAt } } : {}) },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  latestRun(providerKey?: string) {
    return this.prisma.syncRun.findFirst({
      where: providerKey ? { providerKey } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  findRun(id: string) {
    return this.prisma.syncRun.findUnique({ where: { id } });
  }

  /** Field-level changes attributed to a sync run, newest first, with resource info. */
  changesForRun(syncRunId: string, take = 200) {
    return this.prisma.changeEvent.findMany({
      where: { syncRunId },
      orderBy: { detectedAt: 'desc' },
      take,
      include: { resource: { select: { id: true, name: true, type: true } } },
    });
  }

  async upsertSubscription(scope: Scope, providerKey: string): Promise<string> {
    const tenantExternalId = (scope.metadata?.tenantId as string) ?? undefined;
    const orgName = (scope.metadata?.orgName as string) ?? tenantExternalId;
    let tenantId: string | undefined;
    if (tenantExternalId) {
      const tenant = await this.prisma.tenant.upsert({
        where: { externalId: tenantExternalId },
        update: { name: orgName ?? tenantExternalId },
        create: { externalId: tenantExternalId, name: orgName ?? tenantExternalId, providerKey },
      });
      tenantId = tenant.id;
    }
    const sub = await this.prisma.subscription.upsert({
      where: { externalId: scope.externalId },
      update: { name: scope.name, state: scope.state ?? null, tenantId, lastSyncedAt: new Date() },
      create: {
        externalId: scope.externalId,
        name: scope.name,
        state: scope.state ?? null,
        providerKey,
        tenantId,
        lastSyncedAt: new Date(),
      },
    });
    return sub.id;
  }

  async upsertResourceGroup(scope: Scope, subscriptionDbId: string, providerKey: string): Promise<string> {
    const tags = (scope.metadata?.tags ?? {}) as PrismaNS.InputJsonValue;
    const rg = await this.prisma.resourceGroup.upsert({
      where: { externalId: scope.externalId },
      update: { name: scope.name, location: scope.location ?? null, tags, subscriptionId: subscriptionDbId, lastSyncedAt: new Date() },
      create: {
        externalId: scope.externalId,
        name: scope.name,
        location: scope.location ?? null,
        tags,
        subscriptionId: subscriptionDbId,
        providerKey,
        lastSyncedAt: new Date(),
      },
    });
    return rg.id;
  }

  /**
   * Existing resources for a batch of external ids, keyed by the LOWER-CASED id.
   * Azure ids are case-insensitive and Azure is not consistent about their
   * case (`resourceGroups/APP-PROD` one day, `/App-Prod` the next); matching exactly
   * created a second row for the same resource on every flip. Where legacy
   * duplicates exist, the active, most recently synced row is the match.
   */
  async findResourcesByExternalIds(externalIds: string[]): Promise<Map<string, ReconcileRow>> {
    const out = new Map<string, ReconcileRow>();
    const lowered = [...new Set(externalIds.map((id) => id.toLowerCase()))];
    for (const batch of chunks(lowered)) {
      const idRows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Resource" WHERE lower("externalId") = ANY(${batch}::text[])`;
      if (idRows.length === 0) continue;
      const rows = await this.prisma.resource.findMany({
        where: { id: { in: idRows.map((r) => r.id) } },
        select: reconcileSelect,
      });
      for (const r of rows) {
        const key = r.externalId.toLowerCase();
        const current = out.get(key);
        if (!current || preferred(r, current)) out.set(key, r);
      }
    }
    return out;
  }

  createResource(data: {
    externalId: string;
    name: string;
    type: string;
    providerKey: string;
    location: string | null;
    sku: string | null;
    owner: string | null;
    azureCreatedAt: Date | null;
    tags: unknown;
    properties: unknown;
    propertiesHash: string;
    subscriptionId: string | null;
    resourceGroupId: string | null;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.resource.create({
        data: { ...data, tags: data.tags as object, properties: data.properties as object, lastSyncedAt: new Date() },
        select: { id: true },
      });
      await tx.assetLifecycleEvent.create({ data: { resourceId: created.id, stage: 'Created', actor: 'sync' } });
      return created;
    });
  }

  /** Update a resource's columns without recording drift (e.g. creation-time backfill). */
  updateResource(id: string, data: Record<string, unknown>) {
    return this.prisma.resource.update({ where: { id }, data: { ...data, lastSyncedAt: new Date() }, select: { id: true } });
  }

  /** Mark a batch of unchanged resources as seen by this sync. */
  async touchResources(ids: string[]): Promise<void> {
    const now = new Date();
    for (const batch of chunks(ids)) {
      await this.prisma.resource.updateMany({ where: { id: { in: batch } }, data: { lastSyncedAt: now } });
    }
  }

  /**
   * Persist a drifted resource atomically: its ChangeEvents, the new values and
   * the lifecycle entry commit together or not at all.
   */
  applyResourceChange(input: {
    resourceId: string;
    syncRunId: string;
    changes: { field: string; oldValue: unknown; newValue: unknown }[];
    data: Record<string, unknown>;
    lifecycleReason?: string;
  }) {
    return this.prisma.$transaction([
      this.prisma.changeEvent.createMany({
        data: input.changes.map((c) => ({
          resourceId: input.resourceId,
          syncRunId: input.syncRunId,
          field: c.field,
          oldValue: (c.oldValue ?? PrismaNS.JsonNull) as PrismaNS.InputJsonValue,
          newValue: (c.newValue ?? PrismaNS.JsonNull) as PrismaNS.InputJsonValue,
        })),
      }),
      this.prisma.resource.update({
        where: { id: input.resourceId },
        data: { ...input.data, lastSyncedAt: new Date() },
        select: { id: true },
      }),
      this.prisma.assetLifecycleEvent.create({
        data: { resourceId: input.resourceId, stage: 'Modified', actor: 'sync', reason: input.lifecycleReason },
      }),
    ]);
  }

  /** Active resources of a subscription (id only) — the "expected" set for deletion reconciliation. */
  activeResourceIds(subscriptionDbId: string) {
    return this.prisma.resource.findMany({
      where: { subscriptionId: subscriptionDbId, state: 'active' },
      select: { id: true },
    });
  }

  /**
   * Flag resources that no longer exist in the provider as deleted, recording a
   * `state` ChangeEvent and a `Deleted` lifecycle entry for each. Reversible: a
   * resource that reappears in a later sync is restored to active.
   */
  async markDeleted(ids: string[], syncRunId: string): Promise<number> {
    let total = 0;
    for (const batch of chunks(ids)) {
      const [, , updated] = await this.prisma.$transaction([
        this.prisma.changeEvent.createMany({
          data: batch.map((resourceId) => ({ resourceId, syncRunId, field: 'state', oldValue: 'active', newValue: 'deleted' })),
        }),
        this.prisma.assetLifecycleEvent.createMany({
          data: batch.map((resourceId) => ({
            resourceId,
            stage: 'Deleted' as const,
            actor: 'sync',
            reason: 'No longer present in the provider',
          })),
        }),
        this.prisma.resource.updateMany({
          where: { id: { in: batch }, state: 'active' },
          data: { state: 'deleted', lifecycleStage: 'Deleted', lastSyncedAt: new Date() },
        }),
      ]);
      total += updated.count;
    }
    return total;
  }

  /**
   * Replace the topology edges discovered this run. `fullReset` (a full-estate
   * sync) clears every edge first; a scoped sync only clears edges whose source
   * is one of the resources it re-processed. Both then bulk-insert the resolved
   * edges (unique on source+target+type dedupes any overlap).
   */
  async replaceRelationships(
    edges: { sourceId: string; targetId: string; type: string }[],
    opts: { fullReset: boolean; sourceIds: string[] },
  ): Promise<void> {
    await this.prisma.$transaction([
      opts.fullReset
        ? this.prisma.resourceRelationship.deleteMany({})
        : this.prisma.resourceRelationship.deleteMany({ where: { sourceId: { in: opts.sourceIds } } }),
      this.prisma.resourceRelationship.createMany({ data: edges, skipDuplicates: true }),
    ]);
  }
}
