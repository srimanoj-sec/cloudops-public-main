import type { Prisma as PrismaNS } from '@prisma/client';
import type { Prisma } from '../../infra/prisma.js';
import type { BuiltinStandardDef } from './standards.catalog.js';
import { TEMPLATES } from './standards.library.js';

export interface ComplianceRow {
  ruleId: string;
  scopeType: string;
  scopeId: string;
  passed: boolean;
  exempt: boolean;
  detail: string | null;
}

function slug(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  return `${base || 'rule'}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Data-access for the standards catalog, compliance results and exemptions. */
/** Every field a rule evaluation reads from a resource. */
const RESOURCE_EVAL_SELECT = {
  id: true,
  externalId: true,
  name: true,
  type: true,
  location: true,
  sku: true,
  owner: true,
  tags: true,
  platformTags: true,
  lifecycleStage: true,
  inUse: true,
  retireBy: true,
  costDaily: true,
  costMonthly: true,
  azureCreatedAt: true,
  createdAt: true,
  properties: true,
  subscriptionId: true,
  resourceGroupId: true,
  subscription: { select: { name: true } },
  resourceGroup: { select: { name: true } },
} as const;

export class StandardsRepository {
  constructor(private readonly prisma: Prisma) {}

  /**
   * Upsert the built-in standards into Standard/StandardRule (idempotent by key).
   * Code owns a built-in rule's identity, name, description and category; the
   * user owns its `enabled` switch, severity override and parameters (only set
   * on first creation, never overwritten). Custom rows are untouched.
   */
  async upsertCatalog(catalog: BuiltinStandardDef[]) {
    for (const std of catalog) {
      const standard = await this.prisma.standard.upsert({
        where: { key: std.key },
        update: { name: std.name, description: std.description, source: 'builtin' },
        create: { key: std.key, name: std.name, description: std.description, source: 'builtin' },
      });
      for (const rule of std.rules) {
        const t = TEMPLATES.get(rule.key);
        if (!t) continue;
        await this.prisma.standardRule.upsert({
          where: { standardId_key: { standardId: standard.id, key: rule.key } },
          update: { name: t.name, description: t.description, category: t.category, template: t.key, source: 'builtin' },
          create: {
            standardId: standard.id,
            key: rule.key,
            name: t.name,
            description: t.description,
            severity: t.severity,
            category: t.category,
            template: t.key,
            source: 'builtin',
            enabled: rule.enabled ?? true,
          },
        });
      }
    }
    return this.loadCatalog();
  }

  loadCatalog() {
    // Built-in standards first (source 'builtin' < 'custom'), then by name.
    return this.prisma.standard.findMany({
      orderBy: [{ source: 'asc' }, { name: 'asc' }],
      include: { rules: { orderBy: [{ source: 'asc' }, { key: 'asc' }] } },
    });
  }

  // ── Custom standard / rule authoring ─────────────────────────────

  createStandard(name: string, description: string | null) {
    return this.prisma.standard.create({
      data: { key: slug(name), name, description, source: 'custom' },
    });
  }

  getStandard(id: string) {
    return this.prisma.standard.findUnique({ where: { id } });
  }

  deleteStandard(id: string) {
    // Cascades to its rules, their results and exemptions.
    return this.prisma.standard.delete({ where: { id } });
  }

  createRule(standardId: string, data: Omit<PrismaNS.StandardRuleUncheckedCreateInput, 'standardId' | 'key'>) {
    return this.prisma.standardRule.create({
      data: { ...data, standardId, key: slug(data.name ?? 'rule') },
    });
  }

  getRule(id: string) {
    return this.prisma.standardRule.findUnique({ where: { id }, include: { standard: { select: { source: true } } } });
  }

  updateRule(id: string, data: PrismaNS.StandardRuleUpdateInput) {
    return this.prisma.standardRule.update({ where: { id }, data });
  }

  deleteRule(id: string) {
    return this.prisma.standardRule.delete({ where: { id } });
  }

  // ── Evaluation inputs ────────────────────────────────────────────

  /**
   * Every active resource, light: identity, cost, and only the configuration
   * other resources' rules look up (NIC IP configurations, a web app's plan
   * and state). Builds the cross-resource context without loading every
   * resource's full properties into memory.
   */
  lightContext() {
    return this.prisma.$queryRaw<
      { id: string; externalId: string; name: string; type: string; costDaily: number | null; costMonthly: number | null; createdAt: Date; props: Record<string, unknown> }[]
    >`
      SELECT id, "externalId", name, type, "costDaily", "costMonthly", coalesce("azureCreatedAt", "createdAt") AS "createdAt",
             CASE
               WHEN lower(type) = 'microsoft.network/networkinterfaces' THEN jsonb_build_object('ipConfigurations', properties->'ipConfigurations')
               WHEN lower(type) = 'microsoft.web/sites' THEN jsonb_build_object('serverFarmId', properties->'serverFarmId', 'state', properties->'state')
               ELSE '{}'::jsonb
             END AS props
      FROM "Resource" WHERE state = 'active'`;
  }

  /** One page of active resources with everything rules read (keyset on id). */
  activeResourceBatch(afterId: string | null, take: number) {
    return this.prisma.resource.findMany({
      where: { state: 'active', ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' },
      take,
      select: RESOURCE_EVAL_SELECT,
    });
  }

  resourcesForEval(ids: string[]) {
    return this.prisma.resource.findMany({ where: { state: 'active', id: { in: ids } }, select: RESOURCE_EVAL_SELECT });
  }

  /**
   * Replace every verdict inside ONE transaction while the caller streams new
   * rows in batches: readers keep seeing the previous evaluation until commit,
   * and memory holds one batch at a time however large the estate is.
   */
  async replaceResultsStreaming(produce: (write: (rows: ComplianceRow[]) => Promise<void>) => Promise<void>): Promise<void> {
    const CHUNK = 5000;
    await this.prisma.$transaction(
      async (tx) => {
        await tx.complianceResult.deleteMany({});
        await produce(async (rows) => {
          for (let i = 0; i < rows.length; i += CHUNK) await tx.complianceResult.createMany({ data: rows.slice(i, i + CHUNK) });
        });
      },
      { timeout: 15 * 60_000, maxWait: 10_000 },
    );
  }

  async costSynced(): Promise<boolean> {
    return (await this.prisma.costRecord.findFirst({ select: { id: true } })) !== null;
  }

  /** Exemptions in force at `now` (expired ones stop applying). */
  activeExemptions(now: Date) {
    return this.prisma.complianceExemption.findMany({
      where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { ruleId: true, resourceId: true },
    });
  }

  /** Replace the verdicts of just these resources (targeted re-evaluation). */
  async replaceResultsFor(resourceIds: string[], rows: ComplianceRow[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.complianceResult.deleteMany({ where: { scopeType: 'resource', scopeId: { in: resourceIds } } });
      if (rows.length) await tx.complianceResult.createMany({ data: rows });
    });
  }

  /** Every (rule, resource) currently failing and not exempt — to spot new failures. */
  async failingPairs(): Promise<Set<string>> {
    const rows = await this.prisma.complianceResult.findMany({
      where: { passed: false, exempt: false },
      select: { ruleId: true, scopeId: true },
    });
    return new Set(rows.map((r) => `${r.ruleId}|${r.scopeId}`));
  }

  groupByRuleVerdict() {
    return this.prisma.complianceResult.groupBy({ by: ['ruleId', 'passed', 'exempt'], _count: { _all: true } });
  }

  async latestEvaluatedAt(): Promise<Date | null> {
    const r = await this.prisma.complianceResult.findFirst({
      orderBy: { evaluatedAt: 'desc' },
      select: { evaluatedAt: true },
    });
    return r?.evaluatedAt ?? null;
  }

  activeResourceCount() {
    return this.prisma.resource.count({ where: { state: 'active' } });
  }

  resultsForRule(ruleId: string, passed: boolean | undefined, take = 500) {
    return this.prisma.complianceResult.findMany({
      where: { ruleId, ...(passed === undefined ? {} : { passed }) },
      orderBy: [{ exempt: 'asc' }, { evaluatedAt: 'desc' }],
      take,
    });
  }

  resultsForResource(resourceId: string) {
    return this.prisma.complianceResult.findMany({
      where: { scopeType: 'resource', scopeId: resourceId },
    });
  }

  resourcesByIds(ids: string[]) {
    return this.prisma.resource.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        type: true,
        subscription: { select: { name: true } },
        resourceGroup: { select: { name: true } },
      },
    });
  }

  // ── Exemptions ───────────────────────────────────────────────────

  exemptionsFor(where: PrismaNS.ComplianceExemptionWhereInput) {
    return this.prisma.complianceExemption.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  /** The exemption register: every exemption with what it exempts, soonest expiry first. */
  exemptionRegister(where: PrismaNS.ComplianceExemptionWhereInput) {
    return this.prisma.complianceExemption.findMany({
      where,
      orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 1000,
      include: {
        resource: { select: { name: true } },
        rule: { select: { name: true, description: true, severity: true, standard: { select: { name: true } } } },
      },
    });
  }

  upsertExemption(data: {
    ruleId: string;
    resourceId: string;
    reason: string;
    expiresAt: Date | null;
    createdById: string | null;
    createdBy: string | null;
  }) {
    return this.prisma.complianceExemption.upsert({
      where: { ruleId_resourceId: { ruleId: data.ruleId, resourceId: data.resourceId } },
      update: { reason: data.reason, expiresAt: data.expiresAt, createdById: data.createdById, createdBy: data.createdBy },
      create: data,
    });
  }

  getExemption(id: string) {
    return this.prisma.complianceExemption.findUnique({ where: { id } });
  }

  deleteExemption(id: string) {
    return this.prisma.complianceExemption.delete({ where: { id } });
  }

  /** Reflect a new/removed exemption in the stored results immediately (no full re-evaluation). */
  setResultExempt(ruleId: string, resourceId: string, exempt: boolean) {
    return this.prisma.complianceResult.updateMany({
      where: { ruleId, scopeType: 'resource', scopeId: resourceId, passed: false },
      data: { exempt },
    });
  }
}
