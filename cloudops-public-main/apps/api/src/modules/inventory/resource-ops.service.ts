import { Prisma as PrismaNS } from '@prisma/client';
import type { ResourceRefreshResultDto } from '@cloudops/core';
import type { CredentialChain } from '@cloudops/credentials';
import type { Logger } from '@cloudops/kernel';
import type { ProviderRegistry } from '@cloudops/provider-sdk';
import { AppError } from '../../http/errors.js';
import type { Prisma } from '../../infra/prisma.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import type { StandardsService } from '../standards/standards.service.js';

const NOT_FOUND = /not ?found|ResourceNotFound|ResourceGroupNotFound|\b404\b/i;

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    .join(',')}}`;
}

function tagValue(tags: Record<string, string>, key: string): string | null {
  const k = Object.keys(tags).find((t) => t.toLowerCase() === key.toLowerCase());
  return k ? (tags[k] ?? null) : null;
}

/**
 * Operations on a single resource that don't change it in the cloud:
 * re-read it from the provider now (instead of waiting for the next sync), and
 * re-evaluate its compliance. Both are audited.
 */
export class ResourceOpsService {
  constructor(
    private readonly prisma: Prisma,
    private readonly registry: ProviderRegistry,
    private readonly credentials: CredentialChain,
    private readonly standards: StandardsService,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    private readonly ownerTag: string,
  ) {}

  async refresh(id: string, actor: AuditActor | null): Promise<ResourceRefreshResultDto> {
    const r = await this.prisma.resource.findFirst({ where: { OR: [{ id }, { externalId: id }] } });
    if (!r) throw AppError.notFound('Resource not found');
    if (!this.registry.has(r.providerKey)) throw AppError.badRequest(`Provider ${r.providerKey} is not registered.`);
    const provider = this.registry.get(r.providerKey);
    const credential = await this.credentials.resolve({ providerKey: r.providerKey });
    const log = this.logger.child({ module: 'resource-refresh', resourceId: r.id });

    let detail;
    try {
      detail = await provider.getResourceDetail(r.externalId, { credential, log: (level, msg, meta) => log[level](msg, meta) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (NOT_FOUND.test(message)) {
        await this.audit.record({ action: 'resource.refresh', entity: 'resource', entityId: r.id, actor, metadata: { found: false } });
        return {
          found: false,
          changed: [],
          message: 'The provider no longer has this resource. The next full sync flags it deleted (with its safety checks).',
        };
      }
      throw new AppError(502, `Couldn’t read the resource from the provider: ${message.slice(0, 300)}`, 'provider_error');
    }

    const raw = (detail.raw ?? {}) as { properties?: Record<string, unknown> };
    const freshProps = raw.properties ?? detail.properties ?? {};
    // Keep what only the sync's richer query returns (e.g. a VM's power state).
    const merged = { ...((r.properties as Record<string, unknown>) ?? {}), ...freshProps };
    const oldTags = (r.tags as Record<string, string>) ?? {};
    const newTags = detail.tags ?? oldTags;
    const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];
    if (stable(oldTags) !== stable(newTags)) changes.push({ field: 'tags', oldValue: oldTags, newValue: newTags });
    if ((detail.sku ?? r.sku) !== r.sku) changes.push({ field: 'sku', oldValue: r.sku, newValue: detail.sku ?? null });
    if ((detail.location ?? r.location) !== r.location) changes.push({ field: 'location', oldValue: r.location, newValue: detail.location ?? null });
    const configChanged = stable(r.properties) !== stable(merged);
    const owner = tagValue(newTags, this.ownerTag) ?? tagValue((r.platformTags as Record<string, string> | null) ?? {}, this.ownerTag);
    if ((owner ?? null) !== r.owner) changes.push({ field: 'owner', oldValue: r.owner, newValue: owner ?? null });

    await this.prisma.$transaction([
      this.prisma.resource.update({
        where: { id: r.id },
        data: {
          properties: merged as PrismaNS.InputJsonValue,
          // Forces the next sync to refresh the stored configuration from its own query.
          propertiesHash: null,
          tags: newTags as PrismaNS.InputJsonValue,
          sku: detail.sku ?? r.sku,
          location: detail.location ?? r.location,
          owner: owner ?? null,
          lastSyncedAt: new Date(),
          ...(changes.length ? { lifecycleStage: 'Modified' } : {}),
        },
      }),
      ...changes.map((c) =>
        this.prisma.changeEvent.create({
          data: {
            resourceId: r.id,
            field: c.field,
            oldValue: (c.oldValue ?? PrismaNS.JsonNull) as PrismaNS.InputJsonValue,
            newValue: (c.newValue ?? PrismaNS.JsonNull) as PrismaNS.InputJsonValue,
          },
        }),
      ),
    ]);
    await this.standards.evaluateResources([r.id]);
    const changed = [...changes.map((c) => c.field), ...(configChanged ? ['configuration'] : [])];
    await this.audit.record({ action: 'resource.refresh', entity: 'resource', entityId: r.id, actor, metadata: { found: true, changed } });
    return {
      found: true,
      changed,
      message: changed.length ? `Updated: ${changed.join(', ')}. Compliance re-evaluated.` : 'Already up to date. Compliance re-evaluated.',
    };
  }

  async evaluateMany(ids: string[], actor: AuditActor | null): Promise<{ evaluated: number }> {
    const rows = await this.prisma.resource.findMany({ where: { id: { in: ids }, state: 'active' }, select: { id: true } });
    await this.standards.evaluateResources(rows.map((r) => r.id));
    await this.audit.record({ action: 'resource.evaluate', entity: 'resource', actor, metadata: { resources: rows.length } });
    return { evaluated: rows.length };
  }

  async evaluate(id: string, actor: AuditActor | null): Promise<void> {
    const r = await this.prisma.resource.findFirst({ where: { OR: [{ id }, { externalId: id }] }, select: { id: true } });
    if (!r) throw AppError.notFound('Resource not found');
    await this.standards.evaluateResources([r.id]);
    await this.audit.record({ action: 'resource.evaluate', entity: 'resource', entityId: r.id, actor });
  }
}
