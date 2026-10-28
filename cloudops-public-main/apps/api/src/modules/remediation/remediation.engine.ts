import { Prisma as PrismaNS } from '@prisma/client';
import type { RemediationLogEntry, RemediationStatus } from '@cloudops/core';
import type { EventBus, Logger } from '@cloudops/kernel';
import type { CredentialChain } from '@cloudops/credentials';
import type { ProviderContext, ProviderRegistry } from '@cloudops/provider-sdk';
import type { Prisma } from '../../infra/prisma.js';
import { logger as rootLogger } from '../../infra/logger.js';
import type { AuditService } from '../audit/audit.service.js';
import type { StandardsService } from '../standards/standards.service.js';
import type { TagsService } from '../tags/tags.service.js';
import {
  ACTION_INDEX,
  type PlanResource,
  type ProviderActionDef,
  type TagActionDef,
} from './remediation.catalog.js';

export interface RemediationEngineDeps {
  prisma: Prisma;
  registry: ProviderRegistry;
  credentials: CredentialChain;
  tags: TagsService;
  standards: StandardsService;
  audit: AuditService;
  events: EventBus;
  logger: Logger;
  ownerTag: string;
}

const NOT_FOUND = /not ?found|ResourceNotFound|ResourceGroupNotFound|\b404\b/i;

function readPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function withPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  const parts = path.split('.');
  let cur = out;
  for (const [i, part] of parts.entries()) {
    if (i === parts.length - 1) cur[part] = value;
    else {
      const next = cur[part];
      cur[part] = next && typeof next === 'object' ? { ...(next as Record<string, unknown>) } : {};
      cur = cur[part] as Record<string, unknown>;
    }
  }
  return out;
}

const raw = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ');

/**
 * What a run's log (readable by everyone) may say about an error. Provider and
 * app errors are written for operators and shown as-is; database and programming
 * errors could reveal internals, so they are summarised and logged in full.
 */
const brief = (err: unknown) => {
  const internal =
    err instanceof PrismaNS.PrismaClientKnownRequestError ||
    err instanceof PrismaNS.PrismaClientUnknownRequestError ||
    err instanceof PrismaNS.PrismaClientValidationError ||
    err instanceof TypeError ||
    err instanceof ReferenceError;
  if (!internal) return raw(err).slice(0, 400);
  rootLogger.error('remediation: internal error', { error: raw(err) });
  return 'Unexpected internal error — the details are in the API log.';
};

/**
 * Executes one approved remediation run, target by target (sequentially — a
 * change estate-wide should never race itself). Each change is verified by
 * reading the resource back from the provider; the cache is updated and the
 * affected resources are re-evaluated, so the finding disappears (or stays,
 * with the reason) without waiting for the next sync.
 */
export class RemediationEngine {
  constructor(private readonly d: RemediationEngineDeps) {}

  async run(runId: string): Promise<void> {
    const { prisma, logger } = this.d;
    const run = await prisma.remediationRun.findUnique({
      where: { id: runId },
      include: { targets: true },
    });
    if (!run || run.status !== 'queued') {
      logger.warn('remediation job skipped: run is not queued', { runId, status: run?.status });
      return;
    }
    const def = ACTION_INDEX.get(run.actionKey);
    const log: RemediationLogEntry[] = [...((run.log as unknown as RemediationLogEntry[]) ?? [])];
    const say = (level: RemediationLogEntry['level'], message: string) =>
      log.push({ at: new Date().toISOString(), level, message });
    const flush = () =>
      prisma.remediationRun.update({
        where: { id: runId },
        data: { log: log as unknown as PrismaNS.InputJsonValue },
      });

    await prisma.remediationRun.update({
      where: { id: runId },
      data: { status: 'running', startedAt: new Date() },
    });
    say('info', `Started: ${run.title}`);
    const actor = run.executedById ? { id: run.executedById, name: run.executedBy } : null;
    const params = (run.params as Record<string, unknown> | null) ?? {};
    const counts = { total: 0, succeeded: 0, failed: 0, skipped: 0, verified: 0 };
    const touched: string[] = [];

    if (!def) {
      say('error', `Unknown action ${run.actionKey}`);
      await this.finish(runId, 'failed', counts, log, `Unknown action ${run.actionKey}`, run);
      return;
    }

    let ctx: ProviderContext;
    try {
      const credential = await this.d.credentials.resolve({ providerKey: run.providerKey });
      const plog = logger.child({ remediationRun: runId });
      ctx = { credential, log: (level, msg, meta) => plog[level](msg, meta) };
    } catch (err) {
      say('error', `No credentials for ${run.providerKey}: ${brief(err)}`);
      await this.finish(runId, 'failed', counts, log, brief(err), run);
      return;
    }

    for (const t of run.targets) {
      counts.total++;
      if (t.status !== 'pending') {
        counts.skipped++;
        continue;
      }
      await prisma.remediationTarget.update({
        where: { id: t.id },
        data: { status: 'running', startedAt: new Date() },
      });
      const row = await prisma.resource.findUnique({ where: { id: t.resourceId } });
      const done = async (status: string, message: string, after?: unknown) => {
        await prisma.remediationTarget.update({
          where: { id: t.id },
          data: {
            status,
            message,
            finishedAt: new Date(),
            ...(after !== undefined ? { after: after as PrismaNS.InputJsonValue } : {}),
          },
        });
      };
      if (!row || row.state !== 'active') {
        counts.skipped++;
        await done('skipped', 'No longer exists.');
        say('warn', `${t.resourceName}: skipped — no longer exists`);
        continue;
      }
      const r: PlanResource = {
        id: row.id,
        externalId: row.externalId,
        name: row.name,
        type: row.type.toLowerCase(),
        state: row.state,
        owner: row.owner,
        tags: {
          ...((row.tags as Record<string, string>) ?? {}),
          ...((row.platformTags as Record<string, string> | null) ?? {}),
        },
        properties: (row.properties as Record<string, unknown>) ?? {},
      };
      const cur = def.current(r, params);
      if (cur.skip) {
        counts.skipped++;
        await done('skipped', cur.skip);
        say('info', `${r.name}: skipped — ${cur.skip}`);
        continue;
      }

      try {
        const outcome =
          def.mode === 'tags'
            ? await this.applyTags(def, r, params, actor)
            : await this.applyProvider(run.providerKey, def, r, params, ctx);
        touched.push(r.id);
        counts.succeeded++;
        if (outcome.verified) counts.verified++;
        await done(outcome.verified ? 'verified' : outcome.status, outcome.message, outcome.after);
        say(outcome.verified ? 'info' : 'warn', `${r.name}: ${outcome.message}`);
      } catch (err) {
        counts.failed++;
        await done('failed', brief(err));
        say('error', `${r.name}: failed — ${brief(err)}`);
      }
      await flush();
    }

    if (touched.length) {
      try {
        await this.d.standards.evaluateResources(touched);
        say('info', `Re-evaluated compliance for ${touched.length} resource(s).`);
      } catch (err) {
        say(
          'warn',
          `Compliance re-evaluation failed: ${brief(err)} — the next evaluation will pick the changes up.`,
        );
      }
    }
    const status: RemediationStatus =
      counts.failed === 0 ? 'completed' : counts.succeeded === 0 ? 'failed' : 'partial';
    say(
      status === 'completed' ? 'info' : 'warn',
      `Finished: ${counts.succeeded} changed (${counts.verified} verified), ${counts.failed} failed, ${counts.skipped} skipped.`,
    );
    await this.finish(
      runId,
      status,
      counts,
      log,
      counts.failed ? `${counts.failed} target(s) failed` : null,
      run,
    );
  }

  private async applyProvider(
    providerKey: string,
    def: ProviderActionDef,
    r: PlanResource,
    params: Record<string, unknown>,
    ctx: ProviderContext,
  ): Promise<{ verified: boolean; status: string; message: string; after?: unknown }> {
    const provider = this.d.registry.get(providerKey);
    if (!provider.executeAction) throw new Error('The provider has no actions capability.');
    const action = def.build(r, params);
    await provider.executeAction(action, ctx);

    if (action.kind === 'delete') {
      try {
        await provider.getResourceDetail(r.externalId, ctx);
        return {
          verified: false,
          status: 'verify_failed',
          message: 'Deleted, but it still shows up — Azure may still be removing it.',
        };
      } catch (err) {
        if (!NOT_FOUND.test(raw(err))) throw err;
        await this.d.prisma.$transaction([
          this.d.prisma.resource.update({
            where: { id: r.id },
            data: { state: 'deleted', lifecycleStage: 'Deleted' },
          }),
          this.d.prisma.assetLifecycleEvent.create({
            data: {
              resourceId: r.id,
              stage: 'Deleted',
              actor: 'remediation',
              reason: `Deleted by remediation “${def.title}”`,
            },
          }),
        ]);
        return {
          verified: true,
          status: 'verified',
          message: 'Deleted — confirmed gone.',
          after: 'deleted',
        };
      }
    }

    if (action.kind === 'power') {
      // `az vm …` waits for the operation: completing is Azure's confirmation.
      const state =
        action.operation === 'start' || action.operation === 'restart'
          ? 'PowerState/running'
          : 'PowerState/deallocated';
      await this.patchProperties(r, 'extended.instanceView.powerState.code', state);
      return {
        verified: true,
        status: 'verified',
        message: `Azure reported ${action.operation} complete.`,
        after: state,
      };
    }

    // Property change: read it back.
    const verify = def.verifyPath!;
    const detail = await provider.getResourceDetail(r.externalId, ctx);
    const actual = readPath(
      (detail.raw as { properties?: unknown } | undefined)?.properties,
      verify.path,
    );
    await this.patchProperties(r, verify.path, actual);
    const ok = actual === verify.expected || String(actual) === String(verify.expected);
    return ok
      ? {
          verified: true,
          status: 'verified',
          message: `Set ${verify.path} = ${String(actual)} — confirmed by reading it back.`,
          after: actual,
        }
      : {
          verified: false,
          status: 'verify_failed',
          message: `Azure accepted the change but reports ${verify.path} = ${String(actual)}.`,
          after: actual,
        };
  }

  private async applyTags(
    def: TagActionDef,
    r: PlanResource,
    params: Record<string, unknown>,
    actor: { id: string; name: string | null } | null,
  ): Promise<{ verified: boolean; status: string; message: string; after?: unknown }> {
    const add = def.tags(params, this.d.ownerTag);
    const row = await this.d.prisma.resource.findUniqueOrThrow({
      where: { id: r.id },
      select: { tags: true, platformTags: true, taggableInAzure: true },
    });
    const base =
      row.taggableInAzure === false
        ? ((row.platformTags as Record<string, string> | null) ?? {})
        : ((row.tags as Record<string, string>) ?? {});
    const result = await this.d.tags.setResourceTags(
      r.id,
      def.replace ? add : { ...base, ...add },
      actor,
    );
    const ownerKey = Object.keys(add).find(
      (k) => k.toLowerCase() === this.d.ownerTag.toLowerCase(),
    );
    if (ownerKey)
      await this.d.prisma.resource.update({ where: { id: r.id }, data: { owner: add[ownerKey] } });
    const final = result.appliedToAzure ? result.tags : (result.platformTags ?? {});
    const ok = Object.entries(add).every(([k, v]) => final[k] === v);
    if (!result.appliedToAzure) {
      return {
        verified: ok,
        status: ok ? 'verified' : 'verify_failed',
        message: 'This type can’t be tagged in Azure — stored as a CloudOps tag.',
        after: final,
      };
    }
    return ok
      ? {
          verified: true,
          status: 'verified',
          message: `Tagged ${Object.entries(add)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')} — confirmed by Azure.`,
          after: final,
        }
      : {
          verified: false,
          status: 'verify_failed',
          message: 'Azure accepted the tags but returned a different set.',
          after: final,
        };
  }

  /** Keep the cached configuration current, so compliance reflects the change now. */
  private async patchProperties(r: PlanResource, path: string, value: unknown): Promise<void> {
    await this.d.prisma.resource.update({
      where: { id: r.id },
      data: {
        properties: withPath(r.properties, path, value) as PrismaNS.InputJsonValue,
        lastSyncedAt: new Date(),
      },
    });
  }

  private async finish(
    runId: string,
    status: RemediationStatus,
    counts: { total: number; succeeded: number; failed: number; skipped: number; verified: number },
    log: RemediationLogEntry[],
    error: string | null,
    run: {
      title: string;
      requestedById: string | null;
      workItemId: string | null;
      executedById: string | null;
      executedBy: string | null;
    },
  ): Promise<void> {
    await this.d.prisma.remediationRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt: new Date(),
        summary: counts,
        error,
        log: log as unknown as PrismaNS.InputJsonValue,
      },
    });
    const actor = run.executedById ? { id: run.executedById, name: run.executedBy } : null;
    const summary = `finished the remediation: ${counts.succeeded} changed, ${counts.verified} verified, ${counts.failed} failed`;
    await this.d.audit.record({
      action: 'remediation.finish',
      entity: 'remediationRun',
      entityId: runId,
      actor,
      metadata: { status, ...counts, summary },
    });
    if (run.workItemId) {
      await this.d.audit.record({
        action: 'remediation.finish',
        entity: 'workItem',
        entityId: run.workItemId,
        actor,
        metadata: { runId, status, summary },
      });
    }
    await this.d.events.emit('remediation.finished', {
      runId,
      title: run.title,
      status,
      requestedById: run.requestedById,
      summary: counts,
    });
  }
}
