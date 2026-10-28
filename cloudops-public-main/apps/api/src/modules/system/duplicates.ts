import type { DuplicateGroupDto, DuplicatePreviewDto, DuplicateMergeResultDto } from '@cloudops/core';
import type { Prisma } from '../../infra/prisma.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';

interface Row {
  id: string;
  name: string;
  type: string;
  state: string;
  externalId: string;
  lastSyncedAt: string | null;
}

/**
 * Duplicate resource rows: the same Azure resource stored twice because its id
 * came back in different letter case (Azure ids are case-insensitive, and the
 * sync matched them case-sensitively before). One row usually ended up
 * "deleted" holding the older history and the cost; the other "active".
 *
 * Merging keeps one row per resource (the active, most recently synced one) and
 * moves everything that pointed at the others onto it — cost, change history,
 * lifecycle, snapshots, relationships, service/environment maps, work links,
 * docs — then deletes the extra rows. Admin-triggered only, with a preview.
 */
export class DuplicateResources {
  constructor(
    private readonly prisma: Prisma,
    private readonly audit: AuditService,
    /** Re-derive cost rollups once cost has moved onto the surviving rows. */
    private readonly afterMerge?: () => Promise<unknown>,
  ) {}

  private async groups(): Promise<{ key: string; rows: Row[] }[]> {
    return this.prisma.$queryRaw<{ key: string; rows: Row[] }[]>`
      SELECT lower("externalId") AS key,
             json_agg(json_build_object(
               'id', id, 'name', name, 'type', type, 'state', state,
               'externalId', "externalId", 'lastSyncedAt', "lastSyncedAt")
               ORDER BY (state = 'active') DESC, "lastSyncedAt" DESC NULLS LAST, "createdAt" ASC) AS rows
      FROM "Resource"
      GROUP BY lower("externalId")
      HAVING count(*) > 1
      ORDER BY 1`;
  }

  async preview(): Promise<DuplicatePreviewDto> {
    const groups = await this.groups();
    const dupIds = groups.flatMap((g) => g.rows.slice(1).map((r) => r.id));
    const [costs, history] = dupIds.length
      ? await Promise.all([
          this.prisma.$queryRaw<{ id: string; n: bigint; total: number | null }[]>`
            SELECT "resourceId" AS id, count(*) AS n, sum(cost)::float AS total
            FROM "CostRecord" WHERE "resourceId" = ANY(${dupIds}::text[]) GROUP BY 1`,
          this.prisma.$queryRaw<{ id: string; n: bigint }[]>`
            SELECT "resourceId" AS id, count(*) AS n FROM "ChangeEvent"
            WHERE "resourceId" = ANY(${dupIds}::text[]) GROUP BY 1`,
        ])
      : [[], []];
    const costBy = new Map(costs.map((c) => [c.id, { n: Number(c.n), total: c.total ?? 0 }]));
    const histBy = new Map(history.map((h) => [h.id, Number(h.n)]));

    const out: DuplicateGroupDto[] = groups.map((g) => {
      const [keep, ...extra] = g.rows;
      return {
        key: g.key,
        keep: { id: keep!.id, name: keep!.name, type: keep!.type, state: keep!.state, lastSyncedAt: keep!.lastSyncedAt },
        remove: extra.map((r) => ({
          id: r.id,
          name: r.name,
          state: r.state,
          externalId: r.externalId,
          costRecords: costBy.get(r.id)?.n ?? 0,
          cost: costBy.get(r.id)?.total ?? 0,
          changeEvents: histBy.get(r.id) ?? 0,
        })),
      };
    });
    return { groups: out, rowsToRemove: dupIds.length };
  }

  async merge(actor: AuditActor | null): Promise<DuplicateMergeResultDto> {
    const groups = await this.groups();
    let removed = 0;
    for (const g of groups) {
      const [keep, ...extra] = g.rows;
      const s = keep!.id;
      const d = extra.map((r) => r.id);
      await this.prisma.$transaction(
        async (tx) => {
          // Straight re-points.
          await tx.$executeRaw`UPDATE "CostRecord" SET "resourceId" = ${s} WHERE "resourceId" = ANY(${d}::text[])`;
          await tx.$executeRaw`UPDATE "ChangeEvent" SET "resourceId" = ${s} WHERE "resourceId" = ANY(${d}::text[])`;
          await tx.$executeRaw`UPDATE "AssetLifecycleEvent" SET "resourceId" = ${s} WHERE "resourceId" = ANY(${d}::text[])`;
          await tx.$executeRaw`UPDATE "ResourceSnapshot" SET "resourceId" = ${s} WHERE "resourceId" = ANY(${d}::text[])`;
          await tx.$executeRaw`
            UPDATE "WorkItemLink" SET "scopeId" = ${s}
            WHERE "scopeType" = 'resource' AND "scopeId" = ANY(${d}::text[])`;

          // Relationships: drop edges the survivor already has, move the rest, drop self-loops.
          await tx.$executeRaw`
            DELETE FROM "ResourceRelationship" r WHERE r."sourceId" = ANY(${d}::text[]) AND EXISTS (
              SELECT 1 FROM "ResourceRelationship" x
              WHERE x."sourceId" = ${s} AND x."targetId" = r."targetId" AND x.type = r.type)`;
          await tx.$executeRaw`UPDATE "ResourceRelationship" SET "sourceId" = ${s} WHERE "sourceId" = ANY(${d}::text[])`;
          await tx.$executeRaw`
            DELETE FROM "ResourceRelationship" r WHERE r."targetId" = ANY(${d}::text[]) AND EXISTS (
              SELECT 1 FROM "ResourceRelationship" x
              WHERE x."targetId" = ${s} AND x."sourceId" = r."sourceId" AND x.type = r.type)`;
          await tx.$executeRaw`UPDATE "ResourceRelationship" SET "targetId" = ${s} WHERE "targetId" = ANY(${d}::text[])`;
          await tx.$executeRaw`DELETE FROM "ResourceRelationship" WHERE "sourceId" = ${s} AND "targetId" = ${s}`;

          // Composite-key maps: copy what the survivor lacks (rows on the duplicates cascade away).
          await tx.$executeRaw`
            INSERT INTO "ResourceServiceMap" ("resourceId", "serviceId")
            SELECT ${s}, "serviceId" FROM "ResourceServiceMap" WHERE "resourceId" = ANY(${d}::text[])
            ON CONFLICT DO NOTHING`;
          await tx.$executeRaw`
            INSERT INTO "ResourceEnvironmentMap" ("resourceId", "environmentId")
            SELECT ${s}, "environmentId" FROM "ResourceEnvironmentMap" WHERE "resourceId" = ANY(${d}::text[])
            ON CONFLICT DO NOTHING`;

          // Per-resource docs: adopt a duplicate's workspace, or fold its documents into ours.
          const own = await tx.workspace.findUnique({ where: { scopeType_scopeId: { scopeType: 'resource', scopeId: s } } });
          const theirs = await tx.workspace.findMany({ where: { scopeType: 'resource', scopeId: { in: d } } });
          let target = own?.id;
          for (const w of theirs) {
            if (!target) {
              await tx.workspace.update({ where: { id: w.id }, data: { scopeId: s } });
              target = w.id;
            } else {
              await tx.document.updateMany({ where: { workspaceId: w.id }, data: { workspaceId: target } });
              await tx.workspace.delete({ where: { id: w.id } });
            }
          }

          // User-entered fields the survivor doesn't have yet.
          const [survivor, dups] = await Promise.all([
            tx.resource.findUniqueOrThrow({ where: { id: s } }),
            tx.resource.findMany({ where: { id: { in: d } }, orderBy: { lastSyncedAt: 'desc' } }),
          ]);
          const carry: Record<string, unknown> = {};
          for (const dup of dups) {
            if (survivor.retireBy == null && dup.retireBy != null && carry.retireBy === undefined) carry.retireBy = dup.retireBy;
            if (survivor.inUse == null && dup.inUse != null && carry.inUse === undefined) carry.inUse = dup.inUse;
            if (survivor.platformTags == null && dup.platformTags != null && carry.platformTags === undefined) carry.platformTags = dup.platformTags;
            if (survivor.azureCreatedAt == null && dup.azureCreatedAt != null && carry.azureCreatedAt === undefined) carry.azureCreatedAt = dup.azureCreatedAt;
          }
          if (Object.keys(carry).length) await tx.resource.update({ where: { id: s }, data: carry });

          // Exemptions: keep the survivor's where both have one for the same rule.
          await tx.$executeRaw`
            UPDATE "ComplianceExemption" e SET "resourceId" = ${s}
            WHERE e."resourceId" = ANY(${d}::text[]) AND NOT EXISTS (
              SELECT 1 FROM "ComplianceExemption" x WHERE x."resourceId" = ${s} AND x."ruleId" = e."ruleId")`;

          // Compliance verdicts are re-derived on the next evaluation.
          await tx.$executeRaw`DELETE FROM "ComplianceResult" WHERE "scopeType" = 'resource' AND "scopeId" = ANY(${d}::text[])`;
          await tx.resource.deleteMany({ where: { id: { in: d } } });
        },
        { timeout: 60_000 },
      );
      removed += d.length;
    }

    if (removed) await this.afterMerge?.();
    await this.audit.record({
      action: 'resource.duplicates.merge',
      entity: 'resource',
      actor,
      metadata: { groups: groups.length, rowsRemoved: removed },
    });
    return { groups: groups.length, rowsRemoved: removed };
  }
}
