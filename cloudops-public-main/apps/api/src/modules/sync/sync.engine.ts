import { createHash } from 'node:crypto';
import type { SyncOrgSummary, SyncSummary } from '@cloudops/core';
import type { EventBus, Logger } from '@cloudops/kernel';
import type { CredentialChain } from '@cloudops/credentials';
import type { ProviderRegistry, ResourceRecord, Scope } from '@cloudops/provider-sdk';
import type { ReconcileRow, SyncRepository } from './sync.repository.js';

export interface SyncEngineDeps {
  registry: ProviderRegistry;
  credentials: CredentialChain;
  repo: SyncRepository;
  events: EventBus;
  logger: Logger;
  /** Tag the owner is read from — also looked up in CloudOps-only tags (default `Owner`). */
  ownerTag?: string;
}

/**
 * The owner for a resource: the provider's (from its own tags), else one kept
 * in CloudOps-only tags — for resource types the provider can't tag, where an
 * owner assigned in CloudOps must survive the next sync.
 */
export function resolveOwner(providerOwner: string | undefined, platformTags: unknown, ownerTag = 'Owner'): string | null {
  if (providerOwner) return providerOwner;
  if (!platformTags || typeof platformTags !== 'object') return null;
  const key = Object.keys(platformTags).find((k) => k.toLowerCase() === ownerTag.toLowerCase());
  const v = key ? (platformTags as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v ? v : null;
}

export interface SyncJob {
  syncRunId: string;
  providerKey: string;
  subscriptionId?: string;
  configDir?: string;
}

type Counts = { created: number; updated: number; changes: number; deleted: number };

/**
 * Deletion-marking safety valve. A subscription whose discovery "succeeds" but
 * suddenly returns far fewer resources is more likely a permissions/API problem
 * than a mass deletion — so we flag nothing and report it instead.
 */
const MASS_DELETE_MIN = 20;
const MASS_DELETE_RATIO = 0.5;

/**
 * Deterministic JSON serialization with sorted keys. Postgres JSONB does not
 * preserve key order, so a naive JSON.stringify comparison produces false-
 * positive diffs. Sorting keys makes change detection order-insensitive.
 */
/** Content hash of a JSON value (key-order independent). */
function hashOf(value: unknown): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Decide which previously-active resources to flag as deleted after a
 * subscription was discovered completely. Pure, so the guard rails are testable.
 */
export function planDeletions(
  expectedIds: string[],
  seenIds: Set<string>,
  discoveredInSubscription: number,
): { ids: string[]; skippedReason?: string } {
  const missing = expectedIds.filter((id) => !seenIds.has(id));
  if (missing.length === 0) return { ids: [] };
  if (discoveredInSubscription === 0) {
    return { ids: [], skippedReason: `provider returned no resources but ${expectedIds.length} were expected` };
  }
  if (missing.length >= MASS_DELETE_MIN && missing.length / expectedIds.length > MASS_DELETE_RATIO) {
    return {
      ids: [],
      skippedReason: `${missing.length} of ${expectedIds.length} resources vanished at once — check the service principal's permissions`,
    };
  }
  return { ids: missing };
}

/**
 * The synchronization engine. Discovers scopes and resources from a provider,
 * upserts them into Postgres (the authoritative offline cache), performs
 * field-level change detection (ChangeEvents), and flags resources that no
 * longer exist as deleted. Idempotent: keyed by external resource id.
 */
export class SyncEngine {
  constructor(private readonly deps: SyncEngineDeps) {}

  async run(job: SyncJob): Promise<Counts> {
    const { registry, credentials, repo, events, logger } = this.deps;
    const log = logger.child({ syncRunId: job.syncRunId, provider: job.providerKey });

    await repo.markRunning(job.syncRunId);
    await events.emit('sync.started', { runId: job.syncRunId, providerKey: job.providerKey, scope: job.subscriptionId });

    const counts: Counts = { created: 0, updated: 0, changes: 0, deleted: 0 };
    try {
      const provider = registry.get(job.providerKey);
      const credential = await credentials.resolve({ providerKey: job.providerKey, scope: job.subscriptionId });
      const accountErrors: { account: string; message: string }[] = [];
      const ctx = {
        credential,
        log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) =>
          log[level](msg, meta),
        reportIssue: (issue: { account?: string; message: string }) =>
          accountErrors.push({ account: issue.account ?? job.providerKey, message: issue.message.slice(0, 500) }),
      };

      // Phase 1: discover + persist the scope hierarchy.
      const subMap = new Map<string, string>(); // subscription externalId -> db id
      const rgMap = new Map<string, string>(); // resource-group externalId -> db id
      const subscriptions: Scope[] = [];

      for await (const scope of provider.discoverScopes(ctx)) {
        if (scope.kind === 'subscription') {
          if (job.subscriptionId && scope.externalId !== job.subscriptionId) continue;
          const id = await repo.upsertSubscription(scope, job.providerKey);
          subMap.set(scope.externalId, id);
          subscriptions.push(scope);
        } else if (scope.kind === 'resourceGroup') {
          const parentDbId = scope.parentExternalId ? subMap.get(scope.parentExternalId) : undefined;
          if (parentDbId) {
            const id = await repo.upsertResourceGroup(scope, parentDbId, job.providerKey);
            rgMap.set(scope.externalId, id);
          }
        }
      }

      // Phase 2: discover resources per subscription and reconcile.
      // Resilient: a subscription that is disabled or inaccessible (e.g. needs
      // re-auth in another tenant) is skipped with a warning — it never aborts
      // the whole run. Real estates routinely contain such subscriptions.
      const skipped: string[] = [];
      const deletionSkipped: string[] = [];
      // Per-organization rollup. Subscriptions carry org attribution in their
      // metadata (set by the provider in multi-org mode); host mode falls back to
      // the tenant id, else 'default'.
      const orgAggs = new Map<string, SyncOrgSummary>();
      const orgBucket = (sub: Scope): SyncOrgSummary => {
        const tenantId = sub.metadata?.tenantId as string | undefined;
        const key = (sub.metadata?.orgName as string) || tenantId || 'default';
        let agg = orgAggs.get(key);
        if (!agg) {
          agg = { organization: key, tenantId, subscriptions: 0, resources: 0, skipped: [] };
          orgAggs.set(key, agg);
        }
        return agg;
      };

      // Topology accumulators: index every reconciled resource by its lowercased
      // external id and collect its outgoing relationship edges (as external-id
      // references). Resolved to db-id edges in Phase 3 once all ids are known.
      const idIndex = new Map<string, string>();
      const edges: { sourceId: string; targetExternalId: string; type: string }[] = [];
      // Every resource seen this run (any subscription) + the subscriptions whose
      // discovery completed — the inputs to deletion reconciliation.
      const seenAll = new Set<string>();
      const completed: { name: string; dbId: string; discovered: number }[] = [];

      for (const sub of subscriptions) {
        const agg = orgBucket(sub);
        agg.subscriptions++;
        if (sub.state && sub.state !== 'Enabled') {
          const note = `${sub.name} (state: ${sub.state})`;
          skipped.push(note);
          agg.skipped.push(note);
          continue;
        }
        const subDbId = subMap.get(sub.externalId)!;
        try {
          // Discovery is fully paged by the provider; collect the subscription's
          // complete listing, then reconcile it in batches.
          const records: ResourceRecord[] = [];
          for await (const rec of provider.discoverResources(sub, ctx)) records.push(rec);

          const existing = await repo.findResourcesByExternalIds(records.map((r) => r.externalId));
          const unchanged: string[] = [];
          for (const rec of records) {
            const dbId = await this.reconcileResource(
              rec,
              existing.get(rec.externalId.toLowerCase()),
              job,
              subMap,
              rgMap,
              counts,
              unchanged,
            );
            seenAll.add(dbId);
            idIndex.set(rec.externalId.toLowerCase(), dbId);
            for (const rel of rec.relationships ?? []) {
              edges.push({ sourceId: dbId, targetExternalId: rel.targetExternalId, type: rel.type });
            }
          }
          await repo.touchResources(unchanged);
          agg.resources += records.length;
          completed.push({ name: sub.name, dbId: subDbId, discovered: records.length });
        } catch (subErr) {
          // A failed discovery is NOT evidence of deletion — nothing is flagged.
          const msg = subErr instanceof Error ? subErr.message : String(subErr);
          const note = `${sub.name} (${msg})`;
          skipped.push(note);
          agg.skipped.push(note);
          log.warn('skipped subscription during resource discovery', { subscription: sub.name, error: msg });
        }
      }
      if (skipped.length) {
        log.warn(`sync completed with ${skipped.length} subscription(s) skipped`, { skipped });
      }

      // Phase 2b: deletion reconciliation — only for subscriptions whose
      // discovery completed, and only after ALL of them were reconciled (so a
      // resource that moved between subscriptions is never flagged).
      for (const sub of completed) {
        const expected = (await repo.activeResourceIds(sub.dbId)).map((r) => r.id);
        const plan = planDeletions(expected, seenAll, sub.discovered);
        if (plan.skippedReason) {
          deletionSkipped.push(`${sub.name}: ${plan.skippedReason}`);
          log.warn('deletion marking skipped for subscription', { subscription: sub.name, reason: plan.skippedReason });
        } else if (plan.ids.length) {
          const marked = await repo.markDeleted(plan.ids, job.syncRunId);
          counts.deleted += marked;
          counts.changes += marked;
          for (const resourceId of plan.ids) await events.emit('resource.deleted', { resourceId });
          log.info(`flagged ${marked} resource(s) deleted in ${sub.name}`);
        }
      }

      // Phase 3: resolve relationship references to in-estate resources and
      // persist the topology edges. Best-effort — a failure here never fails the
      // whole sync (inventory is already reconciled and committed).
      await this.reconcileRelationships(job, idIndex, edges, log);

      const summary: SyncSummary = {
        orgs: [...orgAggs.values()].sort((a, b) => b.resources - a.resources),
        totalSubscriptions: subscriptions.length,
        skipped,
        deleted: counts.deleted,
        ...(deletionSkipped.length ? { deletionSkipped } : {}),
        ...(accountErrors.length ? { accountErrors } : {}),
      };

      const problems = [...accountErrors.map((e) => `${e.account}: ${e.message}`), ...skipped];
      await repo.finishRun(
        job.syncRunId,
        'completed',
        counts,
        problems.length ? `skipped: ${problems.join('; ')}` : undefined,
        summary,
      );
      await events.emit('sync.completed', {
        runId: job.syncRunId,
        providerKey: job.providerKey,
        created: counts.created,
        updated: counts.updated,
        changes: counts.changes,
        deleted: counts.deleted,
      });
      log.info('sync completed', counts);
      return counts;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await repo.finishRun(job.syncRunId, 'failed', counts, message);
      await events.emit('sync.failed', { runId: job.syncRunId, providerKey: job.providerKey, error: message });
      log.error('sync failed', { message });
      throw err;
    }
  }

  /**
   * Resolve the relationship references collected during resource reconciliation
   * to in-estate resource db ids and persist them as topology edges. Edges whose
   * target is not part of the synced estate (external references) are dropped.
   */
  private async reconcileRelationships(
    job: SyncJob,
    idIndex: Map<string, string>,
    edges: { sourceId: string; targetExternalId: string; type: string }[],
    log: Logger,
  ): Promise<void> {
    try {
      const resolved: { sourceId: string; targetId: string; type: string }[] = [];
      const seen = new Set<string>();
      for (const e of edges) {
        const targetId = idIndex.get(e.targetExternalId);
        if (!targetId || targetId === e.sourceId) continue; // external ref or self-loop
        const key = `${e.sourceId}|${targetId}|${e.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push({ sourceId: e.sourceId, targetId, type: e.type });
      }
      await this.deps.repo.replaceRelationships(resolved, {
        // A full-estate sync (no subscription filter) rebuilds the whole graph;
        // a scoped sync only replaces edges for the resources it re-processed.
        fullReset: !job.subscriptionId,
        sourceIds: [...idIndex.values()],
      });
      log.info(`topology: ${resolved.length} relationship edge(s) across ${idIndex.size} resource(s)`);
    } catch (err) {
      log.warn('failed to persist topology relationships', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Create, update or confirm one resource. Unchanged resources are only
   * collected into `unchanged` (touched in one batch by the caller).
   */
  private async reconcileResource(
    rec: ResourceRecord,
    existing: ReconcileRow | undefined,
    job: SyncJob,
    subMap: Map<string, string>,
    rgMap: Map<string, string>,
    counts: Counts,
    unchanged: string[],
  ): Promise<string> {
    const { repo, events } = this.deps;
    const subscriptionId = rec.subscriptionExternalId ? subMap.get(rec.subscriptionExternalId) ?? null : null;
    const resourceGroupId = rec.resourceGroupExternalId ? rgMap.get(rec.resourceGroupExternalId) ?? null : null;

    const nextTags = rec.tags ?? {};
    const nextProps = rec.properties ?? {};
    const nextPropsHash = hashOf(nextProps);
    const nextOwner = resolveOwner(rec.owner, existing?.platformTags, this.deps.ownerTag);
    const nextCreatedAt = rec.azureCreatedAt ? new Date(rec.azureCreatedAt) : null;

    if (!existing) {
      const created = await repo.createResource({
        externalId: rec.externalId,
        name: rec.name,
        type: rec.type,
        providerKey: job.providerKey,
        location: rec.location ?? null,
        sku: rec.sku ?? null,
        owner: nextOwner,
        azureCreatedAt: nextCreatedAt,
        tags: nextTags,
        properties: nextProps,
        propertiesHash: nextPropsHash,
        subscriptionId,
        resourceGroupId,
      });
      counts.created++;
      await events.emit('resource.discovered', {
        resourceId: created.id,
        providerKey: job.providerKey,
        type: rec.type,
      });
      return created.id;
    }

    // Field-level change detection.
    const changed: { field: string; oldValue: unknown; newValue: unknown }[] = [];
    const scalar: [string, unknown, unknown][] = [
      ['name', existing.name, rec.name],
      ['type', existing.type, rec.type],
      ['location', existing.location, rec.location ?? null],
      ['sku', existing.sku, rec.sku ?? null],
      ['owner', existing.owner, nextOwner],
    ];
    for (const [field, oldV, newV] of scalar) {
      if (oldV !== newV) changed.push({ field, oldValue: oldV, newValue: newV });
    }
    if (stableStringify(existing.tags) !== stableStringify(nextTags)) {
      changed.push({ field: 'tags', oldValue: existing.tags, newValue: nextTags });
    }
    // A resource previously flagged deleted is back in the provider.
    const reappeared = existing.state === 'deleted';
    if (reappeared) changed.push({ field: 'state', oldValue: 'deleted', newValue: 'active' });

    // Backfill a real creation time if this run surfaced one we didn't have
    // (e.g. first sync after enabling Resource Graph) — not itself a drift event.
    const backfillCreatedAt = !existing.azureCreatedAt && nextCreatedAt !== null;

    // Configuration (properties) changed without any tracked field changing —
    // e.g. HTTPS-only switched on. Refresh it silently: standards evaluate it,
    // but volatile fields (power state, worker counts) would flood the history.
    const propsChanged = existing.propertiesHash !== nextPropsHash;

    if (changed.length === 0) {
      if (backfillCreatedAt || propsChanged) {
        await repo.updateResource(existing.id, {
          ...(backfillCreatedAt ? { azureCreatedAt: nextCreatedAt } : {}),
          ...(propsChanged ? { properties: nextProps, propertiesHash: nextPropsHash } : {}),
        });
      } else unchanged.push(existing.id);
      return existing.id;
    }

    await repo.applyResourceChange({
      resourceId: existing.id,
      syncRunId: job.syncRunId,
      changes: changed,
      lifecycleReason: reappeared ? 'Reappeared in the provider' : undefined,
      data: {
        name: rec.name,
        type: rec.type,
        location: rec.location ?? null,
        sku: rec.sku ?? null,
        owner: nextOwner,
        azureCreatedAt: nextCreatedAt ?? existing.azureCreatedAt,
        tags: nextTags,
        properties: nextProps,
        propertiesHash: nextPropsHash,
        subscriptionId,
        resourceGroupId,
        state: 'active',
        lifecycleStage: 'Modified',
      },
    });
    for (const c of changed) await events.emit('resource.changed', { resourceId: existing.id, field: c.field });
    counts.updated++;
    counts.changes += changed.length;
    return existing.id;
  }
}
