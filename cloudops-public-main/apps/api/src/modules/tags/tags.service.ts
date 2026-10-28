import { Prisma as PrismaNS } from '@prisma/client';
import type { CredentialChain } from '@cloudops/credentials';
import type { Logger } from '@cloudops/kernel';
import type { CloudProvider, ProviderContext, ProviderRegistry } from '@cloudops/provider-sdk';
import type { ResourceGroupTagResult, TagWriteResult } from '@cloudops/core';
import { AppError } from '../../http/errors.js';
import type { Prisma } from '../../infra/prisma.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import { asMap, diffTags, isUntaggable, type TagMap } from './tags.util.js';

/** Cast a plain tag map to Prisma's Json input type. */
function json(v: unknown): PrismaNS.InputJsonValue {
  return v as PrismaNS.InputJsonValue;
}

/**
 * Tag write-back service. Writes tags to Azure via the provider's `tags`
 * capability, mirrors them into Postgres, and falls back to platform-only
 * storage when a resource type can't be tagged in Azure. Every write is audited.
 * Gated by `writeEnabled` (AZURE_ALLOW_WRITE) and, at the route, by RBAC.
 */
export class TagsService {
  constructor(
    private readonly prisma: Prisma,
    private readonly registry: ProviderRegistry,
    private readonly credentials: CredentialChain,
    private readonly logger: Logger,
    private readonly writeEnabled: boolean,
    private readonly auditLog: AuditService,
    private readonly providerKey = 'azure',
  ) {}

  private assertWriteEnabled(): void {
    if (!this.writeEnabled) {
      throw AppError.forbidden('Azure write-back is disabled. Set AZURE_ALLOW_WRITE=true to enable tag writes.');
    }
  }

  private provider(): CloudProvider & {
    updateResourceTags: NonNullable<CloudProvider['updateResourceTags']>;
  } {
    const provider = this.registry.get(this.providerKey);
    if (!provider.updateResourceTags) {
      throw AppError.badRequest(`Provider "${this.providerKey}" does not support tag writes.`);
    }
    return provider as CloudProvider & { updateResourceTags: NonNullable<CloudProvider['updateResourceTags']> };
  }

  private async ctx(): Promise<ProviderContext> {
    const credential = await this.credentials.resolve({ providerKey: this.providerKey });
    const log = this.logger.child({ module: 'tags' });
    return {
      credential,
      log: (level, msg, meta) => log[level](msg, meta),
    };
  }

  private audit(actor: AuditActor | null | undefined, action: string, entityId: string, metadata: Record<string, unknown>): Promise<void> {
    return this.auditLog.record({ action, entity: 'tags', entityId, actor, metadata });
  }

  /** Set the FULL desired tag set on one resource (writes the diff to Azure). */
  async setResourceTags(idOrExternal: string, desired: TagMap, actor?: AuditActor | null): Promise<TagWriteResult> {
    this.assertWriteEnabled();
    const resource = await this.prisma.resource.findFirst({
      where: { OR: [{ id: idOrExternal }, { externalId: idOrExternal }] },
    });
    if (!resource) throw AppError.notFound('Resource not found');

    const current = asMap(resource.tags);

    // Known-untaggable → store in CloudOps only, never touch Azure.
    if (resource.taggableInAzure === false) {
      await this.prisma.resource.update({ where: { id: resource.id }, data: { platformTags: json(desired) } });
      await this.audit(actor, 'resource.tags.platform-only', resource.id, { tags: desired });
      return {
        appliedToAzure: false,
        taggableInAzure: false,
        tags: current,
        platformTags: desired,
        message: 'Stored in CloudOps only — this resource type cannot be tagged in Azure.',
      };
    }

    const { upserts, removes } = diffTags(current, desired);
    if (Object.keys(upserts).length === 0 && removes.length === 0) {
      return { appliedToAzure: true, taggableInAzure: resource.taggableInAzure, tags: current, platformTags: asMap(resource.platformTags) };
    }

    const provider = this.provider();
    const ctx = await this.ctx();
    try {
      let final = current;
      if (Object.keys(upserts).length) final = await provider.updateResourceTags(resource.externalId, 'Merge', upserts, ctx);
      if (removes.length) {
        const removeMap: TagMap = {};
        for (const k of removes) removeMap[k] = current[k]!;
        final = await provider.updateResourceTags(resource.externalId, 'Delete', removeMap, ctx);
      }
      await this.prisma.resource.update({
        where: { id: resource.id },
        data: { tags: json(final), taggableInAzure: true, platformTags: PrismaNS.DbNull },
      });
      await this.audit(actor, 'resource.tags.write', resource.id, { upserts, removes });
      return { appliedToAzure: true, taggableInAzure: true, tags: final, platformTags: null };
    } catch (err) {
      if (isUntaggable(err)) {
        await this.prisma.resource.update({
          where: { id: resource.id },
          data: { taggableInAzure: false, platformTags: json(desired) },
        });
        await this.audit(actor, 'resource.tags.platform-only', resource.id, { tags: desired, reason: 'untaggable' });
        return {
          appliedToAzure: false,
          taggableInAzure: false,
          tags: current,
          platformTags: desired,
          message: 'Azure rejected tags for this resource type — stored in CloudOps only.',
        };
      }
      throw AppError.badRequest(err instanceof Error ? err.message : 'Tag write failed');
    }
  }

  /**
   * Apply-once: merge `apply` onto the resource group and every resource in it.
   * Sequential (avoids concurrent `az` token races). Untaggable resources fall
   * back to platform-only storage; other failures are collected and reported.
   */
  async applyResourceGroupTags(
    idOrExternal: string,
    apply: TagMap,
    actor?: AuditActor | null,
    onProgress?: (done: number, total: number) => void | Promise<void>,
  ): Promise<ResourceGroupTagResult> {
    this.assertWriteEnabled();
    const rg = await this.prisma.resourceGroup.findFirst({
      where: { OR: [{ id: idOrExternal }, { externalId: idOrExternal }] },
    });
    if (!rg) throw AppError.notFound('Resource group not found');

    const provider = this.provider();
    const ctx = await this.ctx();
    const result: ResourceGroupTagResult = {
      rgApplied: false,
      total: 0,
      tagged: 0,
      platformOnly: 0,
      failed: 0,
      errors: [],
      tags: asMap(rg.tags),
    };

    // Tag the resource group itself.
    try {
      const rgTags = await provider.updateResourceTags(rg.externalId, 'Merge', apply, ctx);
      result.rgApplied = true;
      result.tags = rgTags;
      await this.prisma.resourceGroup.update({ where: { id: rg.id }, data: { tags: json(rgTags) } });
    } catch (err) {
      result.errors.push({ resource: rg.name, message: err instanceof Error ? err.message : String(err) });
    }

    const resources = await this.prisma.resource.findMany({
      where: { resourceGroupId: rg.id, state: 'active' },
      select: { id: true, name: true, externalId: true, tags: true, platformTags: true, taggableInAzure: true },
    });
    result.total = resources.length;
    let done = 0;
    await onProgress?.(0, resources.length);

    for (const r of resources) {
      await onProgress?.(done++, resources.length);
      const current = asMap(r.tags);
      // Only the pairs that would actually change.
      const upserts: TagMap = {};
      for (const [k, v] of Object.entries(apply)) if (current[k] !== v) upserts[k] = v;

      if (r.taggableInAzure === false) {
        const merged = { ...asMap(r.platformTags), ...apply };
        await this.prisma.resource.update({ where: { id: r.id }, data: { platformTags: json(merged) } });
        result.platformOnly++;
        continue;
      }
      if (Object.keys(upserts).length === 0) {
        result.tagged++; // already compliant
        continue;
      }
      try {
        const final = await provider.updateResourceTags(r.externalId, 'Merge', upserts, ctx);
        await this.prisma.resource.update({
          where: { id: r.id },
          data: { tags: json(final), taggableInAzure: true },
        });
        result.tagged++;
      } catch (err) {
        if (isUntaggable(err)) {
          const merged = { ...asMap(r.platformTags), ...apply };
          await this.prisma.resource.update({
            where: { id: r.id },
            data: { taggableInAzure: false, platformTags: json(merged) },
          });
          result.platformOnly++;
        } else {
          result.failed++;
          result.errors.push({ resource: r.name, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    await onProgress?.(resources.length, resources.length);
    await this.audit(actor, 'resourceGroup.tags.apply', rg.id, {
      apply,
      total: result.total,
      tagged: result.tagged,
      platformOnly: result.platformOnly,
      failed: result.failed,
    });
    return result;
  }
}
