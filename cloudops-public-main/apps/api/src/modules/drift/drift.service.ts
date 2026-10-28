import type { Prisma as PrismaNS } from '@prisma/client';
import type { DriftActivityDto, DriftChangeDto, DriftListDto, DriftQuery } from '@cloudops/core';
import type { CredentialChain } from '@cloudops/credentials';
import type { Logger } from '@cloudops/kernel';
import type { ProviderRegistry } from '@cloudops/provider-sdk';
import { AppError } from '../../http/errors.js';
import type { Prisma } from '../../infra/prisma.js';

/** How far before the detection to look in the activity log (changes are found at the next sync). */
const LOOKBACK_MS = 7 * 86_400_000;

type Row = PrismaNS.ChangeEventGetPayload<{
  include: { resource: { select: { id: true; name: true; type: true; subscription: { select: { name: true } }; resourceGroup: { select: { name: true } } } } };
}>;

function toDto(r: Row): DriftChangeDto {
  return {
    id: r.id,
    resourceId: r.resourceId,
    resourceName: r.resource?.name ?? null,
    resourceType: r.resource?.type ?? null,
    subscription: r.resource?.subscription?.name ?? null,
    resourceGroup: r.resource?.resourceGroup?.name ?? null,
    field: r.field,
    oldValue: r.oldValue,
    newValue: r.newValue,
    detectedAt: r.detectedAt.toISOString(),
    syncRunId: r.syncRunId,
  };
}

const INCLUDE = {
  resource: {
    select: { id: true, name: true, type: true, subscription: { select: { name: true } }, resourceGroup: { select: { name: true } } },
  },
} as const;

/** Drift explorer: detected configuration changes, and who made them. */
export class DriftService {
  constructor(
    private readonly prisma: Prisma,
    private readonly registry: ProviderRegistry,
    private readonly credentials: CredentialChain,
    private readonly logger: Logger,
  ) {}

  private where(q: DriftQuery, withField: boolean): PrismaNS.ChangeEventWhereInput {
    const resource: PrismaNS.ResourceWhereInput = {};
    if (q.tenantId) resource.subscription = { tenantId: q.tenantId };
    if (q.subscriptionId) resource.subscriptionId = q.subscriptionId;
    if (q.search) resource.name = { contains: q.search, mode: 'insensitive' };
    return {
      ...(withField && q.field ? { field: q.field } : {}),
      ...(q.resourceId ? { resourceId: q.resourceId } : {}),
      ...(q.syncRunId ? { syncRunId: q.syncRunId } : {}),
      ...(Object.keys(resource).length ? { resource } : {}),
      ...(q.from || q.to ? { detectedAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    };
  }

  async list(q: DriftQuery): Promise<DriftListDto> {
    const where = this.where(q, true);
    const [rows, total, fields] = await Promise.all([
      this.prisma.changeEvent.findMany({ where, include: INCLUDE, orderBy: { detectedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.changeEvent.count({ where }),
      this.prisma.changeEvent.groupBy({ by: ['field'], where: this.where(q, false), _count: { _all: true }, orderBy: { _count: { field: 'desc' } } }),
    ]);
    return {
      items: rows.map(toDto),
      total,
      page: q.page,
      pageSize: q.pageSize,
      totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
      fields: fields.map((f) => ({ field: f.field, count: f._count._all })),
    };
  }

  async get(id: string): Promise<DriftChangeDto> {
    const row = await this.prisma.changeEvent.findUnique({ where: { id }, include: INCLUDE });
    if (!row) throw AppError.notFound('Change not found');
    return toDto(row);
  }

  /**
   * The provider's activity log for the resource in the week before the change
   * was detected — who (user, service principal, policy) made it. Best-effort:
   * any failure is reported as unavailable with the reason, never an error.
   */
  async activity(id: string): Promise<DriftActivityDto> {
    const row = await this.prisma.changeEvent.findUnique({
      where: { id },
      include: { resource: { select: { externalId: true, providerKey: true } } },
    });
    if (!row) throw AppError.notFound('Change not found');
    const to = row.detectedAt;
    const from = new Date(to.getTime() - LOOKBACK_MS);
    const window = { from: from.toISOString(), to: to.toISOString() };
    const providerKey = row.resource.providerKey;
    if (!this.registry.has(providerKey)) return { available: false, reason: `Provider ${providerKey} isn't registered.`, window, entries: [] };
    const provider = this.registry.get(providerKey);
    if (!provider.getActivity) return { available: false, reason: `${provider.displayName} doesn’t expose an activity log.`, window, entries: [] };
    try {
      const credential = await this.credentials.resolve({ providerKey });
      const log = this.logger.child({ module: 'drift-activity' });
      const entries = await provider.getActivity(row.resource.externalId, window.from, { credential, log: (level, msg, meta) => log[level](msg, meta) });
      return { available: true, reason: null, window, entries: entries.filter((e) => e.at <= new Date(to.getTime() + 3_600_000).toISOString()).slice(0, 50) };
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      return {
        available: false,
        reason: /authoriz|forbidden|permission/i.test(message)
          ? 'The organization’s credentials can’t read the activity log (needs the Reader role or Monitoring Reader).'
          : `Couldn’t read the activity log: ${message}`,
        window,
        entries: [],
      };
    }
  }
}
