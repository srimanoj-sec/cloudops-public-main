import {
  CONDITION_OPERATOR_LABELS,
  NUMERIC_FIELDS,
  RULE_CATEGORY_LABELS,
  SEVERITY_WEIGHT,
  VALUELESS_OPERATORS,
  type CategoryScoreDto,
  type ComplianceResultDto,
  type ComplianceResultsQuery,
  type CreateExemptionRequest,
  type BulkExemptionRequest,
  type CreateRuleRequest,
  type CreateStandardRequest,
  type ExemptionDto,
  type PreviewRuleRequest,
  type ResourceComplianceDto,
  type RuleCategory,
  type RuleDefinition,
  type RulePreviewDto,
  type RuleScope,
  type RuleScoreDto,
  type RuleTemplateDto,
  type StandardScoreDto,
  type StandardSeverity,
  type StandardsSummaryDto,
  type UpdateRuleRequest,
} from '@cloudops/core';
import type { EventBus } from '@cloudops/kernel';
import { AppError } from '../../http/errors.js';
import type { AuditActor } from '../audit/audit.service.js';
import {
  BUILTIN_STANDARDS,
  describeDefinition,
  describeScope,
  evaluateRule,
  legacyToDefinition,
  libraryDtos,
  mergedParams,
  missingParams,
  type EvaluableRule,
} from './standards.catalog.js';
import { TEMPLATES, safeRegex, type EvalContext, type EvalResource } from './standards.library.js';
import type { ComplianceRow, StandardsRepository } from './standards.repository.js';

type ResourceRow = Awaited<ReturnType<StandardsRepository['activeResourceBatch']>>[number];
type RuleRow = Awaited<ReturnType<StandardsRepository['loadCatalog']>>[number]['rules'][number];
type ExemptionRow = Awaited<ReturnType<StandardsRepository['exemptionsFor']>>[number];

function toEval(r: ResourceRow): EvalResource {
  const tags = { ...((r.tags as Record<string, string>) ?? {}), ...((r.platformTags as Record<string, string> | null) ?? {}) };
  return {
    id: r.id,
    externalId: r.externalId.toLowerCase(),
    name: r.name,
    type: r.type.toLowerCase(),
    location: r.location,
    sku: r.sku,
    owner: r.owner,
    tags,
    lifecycleStage: r.lifecycleStage,
    inUse: r.inUse,
    retireBy: r.retireBy,
    costDaily: r.costDaily,
    costMonthly: r.costMonthly,
    createdAt: r.azureCreatedAt ?? r.createdAt,
    properties: (r.properties as Record<string, unknown>) ?? {},
    subscriptionId: r.subscriptionId,
    subscriptionName: r.subscription?.name ?? null,
    resourceGroupId: r.resourceGroupId,
    resourceGroupName: r.resourceGroup?.name ?? null,
  };
}

function buildContext(resources: EvalResource[], costSynced: boolean): EvalContext {
  const byExternalId = new Map(resources.map((r) => [r.externalId, r]));
  const sitesByPlan = new Map<string, EvalResource[]>();
  for (const r of resources) {
    if (r.type !== 'microsoft.web/sites') continue;
    const plan = r.properties.serverFarmId;
    if (typeof plan !== 'string') continue;
    const key = plan.toLowerCase();
    sitesByPlan.set(key, [...(sitesByPlan.get(key) ?? []), r]);
  }
  return { now: new Date(), costSynced, byExternalId, sitesByPlan };
}

const weight = (severity: string) => SEVERITY_WEIGHT[severity as StandardSeverity] ?? 1;

function scoreFrom(rules: { passed: number; failed: number; severity: string }[]): number {
  let wPass = 0;
  let wTotal = 0;
  for (const r of rules) {
    const w = weight(r.severity);
    wPass += r.passed * w;
    wTotal += (r.passed + r.failed) * w;
  }
  if (wTotal === 0) return 0;
  const score = Math.round((wPass / wTotal) * 100);
  // Never show a perfect score while something fails (rounding would).
  return wPass < wTotal ? Math.min(score, 99) : score;
}

/** Built-in standards in priority order (security first), then custom ones by name. */
const PACK_ORDER = new Map(BUILTIN_STANDARDS.map((s, i) => [s.key, i]));
const packRank = (s: { key: string; source: string }) => (s.source === 'builtin' ? (PACK_ORDER.get(s.key) ?? 50) : 100);

function exemptionDto(e: ExemptionRow): ExemptionDto {
  return {
    id: e.id,
    ruleId: e.ruleId,
    resourceId: e.resourceId,
    reason: e.reason,
    expiresAt: e.expiresAt?.toISOString() ?? null,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
  };
}

/** The rule's category/remediation/applicability, whether built-in, template or conditions. */
function ruleMeta(rule: RuleRow): {
  category: RuleCategory | null;
  remediation: string | null;
  appliesTo: string | null;
  definition: RuleDefinition | null;
} {
  const t = rule.template ? TEMPLATES.get(rule.template) : undefined;
  const definition = rule.template ? null : ((rule.definition as RuleDefinition | null) ?? legacyToDefinition(rule));
  const scope = describeScope(rule.scope as RuleScope | null);
  const base = t ? t.appliesTo : 'All resources';
  const legacyType = rule.appliesToType ? `type contains “${rule.appliesToType}”` : null;
  return {
    category: ((rule.category as RuleCategory | null) ?? t?.category ?? null),
    remediation: rule.remediation ?? t?.remediation ?? null,
    appliesTo: [scope ?? legacyType ?? base].filter(Boolean).join(' · '),
    definition,
  };
}

/** Resources evaluated per batch — bounds memory whatever the estate size. */
const EVAL_BATCH = 1000;
/** A cached summary is trusted this long (other API processes may change rules). */
const SUMMARY_TTL_MS = 60_000;

/** A light context row → just enough of an EvalResource for cross-resource lookups. */
function lightEval(r: { id: string; externalId: string; name: string; type: string; costDaily: number | null; costMonthly: number | null; createdAt: Date; props: Record<string, unknown> }): EvalResource {
  return {
    id: r.id,
    externalId: r.externalId.toLowerCase(),
    name: r.name,
    type: r.type.toLowerCase(),
    location: null,
    sku: null,
    owner: null,
    tags: {},
    lifecycleStage: 'Created',
    inUse: null,
    retireBy: null,
    costDaily: r.costDaily,
    costMonthly: r.costMonthly,
    createdAt: r.createdAt,
    properties: r.props ?? {},
    subscriptionId: null,
    subscriptionName: null,
    resourceGroupId: null,
    resourceGroupName: null,
  };
}

export class StandardsService {
  /** The evaluation in progress, if any — concurrent callers share it. */
  private evaluating?: Promise<StandardsSummaryDto>;
  private summaryCache?: { at: number; value: StandardsSummaryDto };

  /** Rules, exemptions or results changed — recompute the summary next time. */
  invalidate(): void {
    this.summaryCache = undefined;
  }

  constructor(
    private readonly repo: StandardsRepository,
    private readonly events?: EventBus,
  ) {}

  // ── Evaluation ───────────────────────────────────────────────────

  /**
   * Re-score every enabled rule against every active resource it applies to.
   * Concurrent requests (double-clicks, two admins) share the one in-flight
   * evaluation instead of racing each other's result replacement.
   */
  evaluate(): Promise<StandardsSummaryDto> {
    this.evaluating ??= this.runEvaluation().finally(() => {
      this.evaluating = undefined;
    });
    return this.evaluating;
  }

  /** The cross-resource context (parents, plans, NICs) from a light projection of the estate. */
  private async loadContext(): Promise<EvalContext> {
    const [rows, costSynced] = await Promise.all([this.repo.lightContext(), this.repo.costSynced()]);
    return buildContext(rows.map(lightEval), costSynced);
  }

  /** Stream every active resource in batches. */
  private async *resourceBatches(): AsyncGenerator<EvalResource[]> {
    let after: string | null = null;
    for (;;) {
      const rows = await this.repo.activeResourceBatch(after, EVAL_BATCH);
      if (rows.length === 0) return;
      yield rows.map(toEval);
      after = rows[rows.length - 1]!.id;
      if (rows.length < EVAL_BATCH) return;
    }
  }

  /** Evaluate every enabled rule of a catalog against some resources. */
  private verdicts(
    catalog: Awaited<ReturnType<StandardsRepository['loadCatalog']>>,
    resources: EvalResource[],
    ctx: EvalContext,
    exempt: Set<string>,
  ): ComplianceRow[] {
    const rows: ComplianceRow[] = [];
    for (const std of catalog) {
      for (const rule of std.rules) {
        if (!rule.enabled) continue;
        for (const r of resources) {
          const verdict = evaluateRule(rule as EvaluableRule, r, ctx);
          if (!verdict) continue; // not applicable to this resource
          rows.push({
            ruleId: rule.id,
            scopeType: 'resource',
            scopeId: r.id,
            passed: verdict.passed,
            exempt: !verdict.passed && exempt.has(`${rule.id}|${r.id}`),
            detail: verdict.detail ?? null,
          });
        }
      }
    }
    return rows;
  }

  private async runEvaluation(): Promise<StandardsSummaryDto> {
    const catalog = await this.repo.upsertCatalog(BUILTIN_STANDARDS);
    const [ctx, exemptions, previous] = await Promise.all([
      this.loadContext(),
      this.repo.activeExemptions(new Date()),
      this.repo.failingPairs(),
    ]);
    const exempt = new Set(exemptions.map((e) => `${e.ruleId}|${e.resourceId}`));
    // New failures since the previous evaluation (none on the very first one —
    // everything would be "new", which tells nobody anything).
    const fresh = new Map<string, string[]>();
    await this.repo.replaceResultsStreaming(async (write) => {
      for await (const batch of this.resourceBatches()) {
        const rows = this.verdicts(catalog, batch, ctx, exempt);
        if (previous.size > 0) {
          for (const r of rows) {
            if (!r.passed && !r.exempt && !previous.has(`${r.ruleId}|${r.scopeId}`)) {
              fresh.set(r.ruleId, [...(fresh.get(r.ruleId) ?? []), r.scopeId]);
            }
          }
        }
        await write(rows);
      }
    });
    this.invalidate();
    const summary = await this.summary();
    const rules = new Map(catalog.flatMap((s) => s.rules.map((r) => [r.id, r] as const)));
    await this.events?.emit('compliance.evaluated', {
      score: summary.score,
      failed: summary.failed,
      newFailures: [...fresh.entries()].map(([ruleId, resourceIds]) => {
        const rule = rules.get(ruleId);
        return { ruleId, ruleName: rule?.name ?? rule?.description ?? ruleId, severity: rule?.severity ?? 'low', resourceIds };
      }),
    });
    return summary;
  }

  /**
   * Re-evaluate just these resources (after a remediation, a tag change or a
   * refresh) and replace only their verdicts. Rules that look at other
   * resources (parents, plans) still see the whole estate.
   */
  async evaluateResources(resourceIds: string[]): Promise<void> {
    if (!resourceIds.length) return;
    const [catalog, ctx, targets, exemptions] = await Promise.all([
      this.repo.loadCatalog(),
      this.loadContext(),
      this.repo.resourcesForEval(resourceIds),
      this.repo.activeExemptions(new Date()),
    ]);
    const exempt = new Set(exemptions.map((e) => `${e.ruleId}|${e.resourceId}`));
    const rows = this.verdicts(catalog, targets.map(toEval), ctx, exempt);
    await this.repo.replaceResultsFor(resourceIds, rows);
    this.invalidate();
  }

  /** Dry-run a rule definition against the current inventory (nothing is saved). */
  async preview(input: PreviewRuleRequest): Promise<RulePreviewDto> {
    const rule = this.toEvaluable(input);
    const ctx = await this.loadContext();
    let passed = 0;
    let failed = 0;
    let total = 0;
    const samples: RulePreviewDto['samples'] = [];
    for await (const batch of this.resourceBatches()) {
      total += batch.length;
      for (const r of batch) {
        const v = evaluateRule(rule, r, ctx);
        if (!v) continue;
        if (v.passed) passed++;
        else failed++;
        // Keep a bounded sample, failures first.
        if (samples.length < 200 || !v.passed) {
          samples.push({ id: r.id, name: r.name, type: r.type, resourceGroup: r.resourceGroupName, passed: v.passed, detail: v.detail ?? null });
        }
      }
    }
    samples.sort((a, b) => Number(a.passed) - Number(b.passed) || a.name.localeCompare(b.name));
    return { resources: total, applicable: passed + failed, passed, failed, samples: samples.slice(0, 25) };
  }

  // ── Read models ──────────────────────────────────────────────────

  /** Cached — re-aggregating every verdict on each dashboard refresh doesn't scale. */
  async summary(): Promise<StandardsSummaryDto> {
    const hit = this.summaryCache;
    if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.value;
    const value = await this.computeSummary();
    this.summaryCache = { at: Date.now(), value };
    return value;
  }

  private async computeSummary(): Promise<StandardsSummaryDto> {
    const [catalog, grouped, evaluatedAt, resourceCount] = await Promise.all([
      this.repo.loadCatalog(),
      this.repo.groupByRuleVerdict(),
      this.repo.latestEvaluatedAt(),
      this.repo.activeResourceCount(),
    ]);

    const counts = new Map<string, { passed: number; failed: number; exempt: number }>();
    for (const g of grouped) {
      const c = counts.get(g.ruleId) ?? { passed: 0, failed: 0, exempt: 0 };
      if (g.exempt) c.exempt += g._count._all;
      else if (g.passed) c.passed += g._count._all;
      else c.failed += g._count._all;
      counts.set(g.ruleId, c);
    }

    const bySeverity = new Map<string, number>();
    const byCategory = new Map<RuleCategory, { passed: number; failed: number; rules: { passed: number; failed: number; severity: string }[] }>();

    const ordered = [...catalog].sort((a, b) => packRank(a) - packRank(b) || a.name.localeCompare(b.name));
    const standards: StandardScoreDto[] = ordered.map((std) => {
      const rules: RuleScoreDto[] = std.rules.map((rule) => {
        // A disabled rule stops counting immediately (its old results are gone on the next evaluation).
        const c = rule.enabled ? (counts.get(rule.id) ?? { passed: 0, failed: 0, exempt: 0 }) : { passed: 0, failed: 0, exempt: 0 };
        const meta = ruleMeta(rule);
        if (c.failed > 0) bySeverity.set(rule.severity, (bySeverity.get(rule.severity) ?? 0) + c.failed);
        if (meta.category && rule.enabled) {
          const agg = byCategory.get(meta.category) ?? { passed: 0, failed: 0, rules: [] };
          agg.passed += c.passed;
          agg.failed += c.failed;
          agg.rules.push({ ...c, severity: rule.severity });
          byCategory.set(meta.category, agg);
        }
        return {
          id: rule.id,
          key: rule.key,
          name: rule.name ?? rule.description,
          description: rule.description,
          severity: rule.severity,
          source: rule.source,
          enabled: rule.enabled,
          category: meta.category,
          remediation: meta.remediation,
          template: rule.template,
          params: rule.template ? mergedParams(rule.template, rule.params) : null,
          definition: meta.definition,
          scope: (rule.scope as RuleScope | null) ?? null,
          appliesTo: meta.appliesTo,
          field: rule.field ?? null,
          operator: rule.operator ?? null,
          value: rule.value ?? null,
          tagKey: rule.tagKey ?? null,
          appliesToType: rule.appliesToType ?? null,
          passed: c.passed,
          failed: c.failed,
          exempt: c.exempt,
        };
      });
      return {
        id: std.id,
        key: std.key,
        name: std.name,
        description: std.description,
        source: std.source,
        checks: rules.reduce((n, r) => n + r.passed + r.failed, 0),
        passed: rules.reduce((n, r) => n + r.passed, 0),
        failed: rules.reduce((n, r) => n + r.failed, 0),
        exempt: rules.reduce((n, r) => n + r.exempt, 0),
        score: scoreFrom(rules.filter((r) => r.enabled)),
        rules,
      };
    });

    const allRules = standards.flatMap((s) => s.rules).filter((r) => r.enabled);
    const categories: CategoryScoreDto[] = [...byCategory.entries()]
      .map(([category, agg]) => ({
        category,
        label: RULE_CATEGORY_LABELS[category],
        score: scoreFrom(agg.rules),
        passed: agg.passed,
        failed: agg.failed,
      }))
      .sort((a, b) => a.score - b.score);

    return {
      evaluatedAt: evaluatedAt?.toISOString() ?? null,
      resourcesEvaluated: resourceCount,
      totalChecks: allRules.reduce((n, r) => n + r.passed + r.failed, 0),
      passed: allRules.reduce((n, r) => n + r.passed, 0),
      failed: allRules.reduce((n, r) => n + r.failed, 0),
      exempt: allRules.reduce((n, r) => n + r.exempt, 0),
      score: scoreFrom(allRules),
      standards,
      bySeverity: [...bySeverity.entries()].map(([severity, f]) => ({ severity, failed: f })),
      byCategory: categories,
    };
  }

  library(): RuleTemplateDto[] {
    return libraryDtos();
  }

  async results(q: ComplianceResultsQuery): Promise<ComplianceResultDto[]> {
    if (!q.ruleId) return [];
    const catalog = await this.repo.loadCatalog();
    const found = catalog.flatMap((s) => s.rules.map((r) => ({ std: s, rule: r }))).find((x) => x.rule.id === q.ruleId);
    const [rows, exemptions] = await Promise.all([
      this.repo.resultsForRule(q.ruleId, q.passed),
      this.repo.exemptionsFor({ ruleId: q.ruleId }),
    ]);
    const resources = await this.repo.resourcesByIds([...new Set(rows.map((r) => r.scopeId))]);
    const byId = new Map(resources.map((r) => [r.id, r]));
    const exByResource = new Map(exemptions.map((e) => [e.resourceId, e]));
    return rows.map((r) => {
      const res = byId.get(r.scopeId);
      const ex = exByResource.get(r.scopeId);
      return {
        id: r.id,
        ruleId: r.ruleId,
        ruleKey: found?.rule.key ?? '',
        ruleDescription: found?.rule.description ?? '',
        standardKey: found?.std.key ?? '',
        severity: found?.rule.severity ?? 'low',
        scopeType: r.scopeType,
        scopeId: r.scopeId,
        scopeName: res?.name ?? null,
        resourceType: res?.type ?? null,
        resourceGroup: res?.resourceGroup?.name ?? null,
        subscription: res?.subscription?.name ?? null,
        passed: r.passed,
        exempt: r.exempt,
        exemption: ex ? exemptionDto(ex) : null,
        detail: r.detail,
        evaluatedAt: r.evaluatedAt.toISOString(),
      };
    });
  }

  async resourceCompliance(resourceId: string): Promise<ResourceComplianceDto> {
    const [catalog, rows, exemptions] = await Promise.all([
      this.repo.loadCatalog(),
      this.repo.resultsForResource(resourceId),
      this.repo.exemptionsFor({ resourceId }),
    ]);
    const ruleIndex = new Map(catalog.flatMap((s) => s.rules.map((r) => [r.id, { std: s, rule: r }] as const)));
    const exByRule = new Map(exemptions.map((e) => [e.ruleId, e]));
    const results = rows
      .map((row) => {
        const hit = ruleIndex.get(row.ruleId);
        if (!hit || !hit.rule.enabled) return null;
        const meta = ruleMeta(hit.rule);
        const ex = exByRule.get(row.ruleId);
        return {
          ruleId: row.ruleId,
          ruleKey: hit.rule.key,
          ruleName: hit.rule.name ?? hit.rule.description,
          standardKey: hit.std.key,
          standardName: hit.std.name,
          template: hit.rule.template,
          category: meta.category,
          description: hit.rule.description,
          remediation: meta.remediation,
          severity: hit.rule.severity,
          passed: row.passed,
          exempt: row.exempt,
          exemption: ex ? exemptionDto(ex) : null,
          detail: row.detail,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => Number(a.passed) - Number(b.passed) || weight(b.severity) - weight(a.severity));
    const scored = results.filter((r) => !r.exempt);
    return {
      resourceId,
      score: scoreFrom(scored.map((r) => ({ passed: r.passed ? 1 : 0, failed: r.passed ? 0 : 1, severity: r.severity }))),
      passed: scored.filter((r) => r.passed).length,
      failed: scored.filter((r) => !r.passed).length,
      exempt: results.filter((r) => r.exempt).length,
      results,
    };
  }

  // ── Authoring ────────────────────────────────────────────────────

  /** Validate an authored rule and produce its evaluable form (template, conditions or legacy). */
  private toEvaluable(input: PreviewRuleRequest | CreateRuleRequest): EvaluableRule {
    const scope = cleanScope(input.scope);
    if (input.template) {
      const t = TEMPLATES.get(input.template);
      if (!t) throw AppError.badRequest(`Unknown library rule "${input.template}".`);
      const params = mergedParams(t.key, input.params);
      const missing = missingParams(t.key, params);
      if (missing.length) throw AppError.badRequest(`Fill in: ${missing.join(', ')}.`);
      for (const spec of t.params ?? []) {
        if (spec.kind === 'regex' && params[spec.key] && !safeRegex(String(params[spec.key]))) {
          throw AppError.badRequest(`${spec.label} is not a valid regular expression.`);
        }
      }
      return { source: 'custom', template: t.key, params: input.params ?? null, definition: null, scope, ...NO_LEGACY };
    }
    const definition = input.definition ?? (input.field && input.operator ? legacyToDefinition({ ...NO_LEGACY, field: input.field, operator: input.operator, value: input.value ?? null, tagKey: input.tagKey ?? null }) : null);
    if (!definition) throw AppError.badRequest('Pick a library rule or add at least one condition.');
    validateDefinition(definition);
    return {
      source: 'custom',
      template: null,
      params: null,
      definition,
      scope,
      ...NO_LEGACY,
      appliesToType: input.appliesToType?.trim() || null,
    };
  }

  async createStandard(input: CreateStandardRequest): Promise<StandardsSummaryDto> {
    const std = await this.repo.createStandard(input.name, input.description ?? null);
    for (const key of input.templates ?? []) {
      const t = TEMPLATES.get(key);
      if (!t || missingParams(t.key, mergedParams(t.key, null)).length) continue; // needs params — add it explicitly
      await this.repo.createRule(std.id, {
        source: 'custom',
        enabled: true,
        name: t.name,
        description: t.description,
        severity: t.severity,
        category: t.category,
        template: t.key,
      });
    }
    this.invalidate();
    return this.summary();
  }

  async deleteStandard(id: string): Promise<StandardsSummaryDto> {
    const std = await this.repo.getStandard(id);
    if (!std) throw AppError.notFound('Standard not found');
    if (std.source !== 'custom') throw AppError.badRequest('Built-in standards cannot be deleted — disable their rules instead.');
    await this.repo.deleteStandard(id);
    this.invalidate();
    return this.summary();
  }

  async createRule(standardId: string, input: CreateRuleRequest): Promise<StandardsSummaryDto> {
    const std = await this.repo.getStandard(standardId);
    if (!std) throw AppError.notFound('Standard not found');
    if (std.source !== 'custom') throw AppError.badRequest('Rules can only be added to custom standards.');
    const rule = this.toEvaluable(input);
    const t = rule.template ? TEMPLATES.get(rule.template) : undefined;
    await this.repo.createRule(standardId, {
      source: 'custom',
      enabled: true,
      name: input.name,
      description: t ? t.description : describeDefinition(rule.definition as RuleDefinition, CONDITION_OPERATOR_LABELS),
      severity: input.severity,
      category: input.category ?? t?.category ?? null,
      remediation: input.remediation?.trim() || null,
      template: rule.template,
      params: (rule.params as object | null) ?? undefined,
      definition: (rule.definition as object | null) ?? undefined,
      scope: (rule.scope as object | null) ?? undefined,
      appliesToType: rule.appliesToType,
    });
    this.invalidate();
    return this.summary();
  }

  async updateRule(id: string, input: UpdateRuleRequest): Promise<StandardsSummaryDto> {
    const rule = await this.repo.getRule(id);
    if (!rule) throw AppError.notFound('Rule not found');

    // Built-in rules: the switch, the severity and the parameters are yours; the logic is code.
    if (rule.source !== 'custom') {
      const allowed = ['enabled', 'severity', 'params'];
      const extra = Object.keys(input).filter((k) => !allowed.includes(k) && (input as Record<string, unknown>)[k] !== undefined);
      if (extra.length) throw AppError.badRequest('Built-in rules: only enabled, severity and parameters can be changed.');
      if (input.params !== undefined && rule.template) {
        const params = mergedParams(rule.template, input.params);
        const missing = missingParams(rule.template, params);
        if (missing.length && (input.enabled ?? rule.enabled)) throw AppError.badRequest(`Fill in: ${missing.join(', ')}.`);
      }
      if (input.enabled === true && rule.template && input.params === undefined) {
        const missing = missingParams(rule.template, mergedParams(rule.template, rule.params));
        if (missing.length) throw AppError.badRequest(`Set this rule’s parameters first: ${missing.join(', ')}.`);
      }
      await this.repo.updateRule(id, {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.params !== undefined ? { params: (input.params as object | null) ?? undefined } : {}),
      });
      this.invalidate();
      return this.summary();
    }

    // Custom rules: full edit — merge with the stored rule, then validate the result.
    const merged: CreateRuleRequest = {
      name: input.name ?? rule.name ?? rule.description,
      severity: (input.severity ?? rule.severity) as StandardSeverity,
      category: (input.category ?? rule.category ?? undefined) as RuleCategory | undefined,
      remediation: input.remediation === null ? undefined : (input.remediation ?? rule.remediation ?? undefined),
      template: rule.template ?? undefined,
      params: input.params === null ? undefined : ((input.params ?? rule.params ?? undefined) as Record<string, unknown> | undefined),
      definition: input.definition === null ? undefined : ((input.definition ?? rule.definition ?? undefined) as RuleDefinition | undefined),
      scope: input.scope === null ? undefined : ((input.scope ?? rule.scope ?? undefined) as RuleScope | undefined),
      field: (input.field ?? rule.field ?? undefined) as CreateRuleRequest['field'],
      operator: (input.operator ?? rule.operator ?? undefined) as CreateRuleRequest['operator'],
      value: (input.value === undefined ? rule.value : input.value) ?? undefined,
      tagKey: (input.tagKey === undefined ? rule.tagKey : input.tagKey) ?? undefined,
      appliesToType: (input.appliesToType === undefined ? rule.appliesToType : input.appliesToType) ?? undefined,
    };
    const ev = this.toEvaluable(merged);
    const t = ev.template ? TEMPLATES.get(ev.template) : undefined;
    await this.repo.updateRule(id, {
      name: merged.name,
      severity: merged.severity,
      enabled: input.enabled ?? rule.enabled,
      category: merged.category ?? t?.category ?? null,
      remediation: merged.remediation?.trim() || null,
      params: (ev.params as object | null) ?? undefined,
      definition: (ev.definition as object | null) ?? undefined,
      scope: (ev.scope as object | null) ?? undefined,
      description: t ? t.description : describeDefinition(ev.definition as RuleDefinition, CONDITION_OPERATOR_LABELS),
      // A v1 rule edited in the v2 builder becomes a conditions rule.
      ...(input.definition ? { field: null, operator: null, value: null, tagKey: null } : {}),
      appliesToType: ev.appliesToType,
    });
    this.invalidate();
    return this.summary();
  }

  async deleteRule(id: string): Promise<StandardsSummaryDto> {
    const rule = await this.repo.getRule(id);
    if (!rule) throw AppError.notFound('Rule not found');
    if (rule.source !== 'custom') throw AppError.badRequest('Built-in rules cannot be deleted — disable them instead.');
    await this.repo.deleteRule(id);
    this.invalidate();
    return this.summary();
  }

  // ── Exemptions ───────────────────────────────────────────────────

  async listExemptions(filter: { ruleId?: string; resourceId?: string }): Promise<ExemptionDto[]> {
    const rows = await this.repo.exemptionRegister({
      ...(filter.ruleId ? { ruleId: filter.ruleId } : {}),
      ...(filter.resourceId ? { resourceId: filter.resourceId } : {}),
    });
    const now = Date.now();
    const soon = now + 14 * 86_400_000;
    return rows.map((e) => ({
      ...exemptionDto(e),
      resourceName: e.resource.name,
      ruleName: e.rule.name ?? e.rule.description,
      standardName: e.rule.standard.name,
      severity: e.rule.severity,
      status: !e.expiresAt ? 'permanent' : e.expiresAt.getTime() <= now ? 'expired' : e.expiresAt.getTime() <= soon ? 'expiring' : 'active',
    }));
  }

  async createExemption(input: CreateExemptionRequest, actor: AuditActor | null): Promise<ExemptionDto> {
    const rule = await this.repo.getRule(input.ruleId);
    if (!rule) throw AppError.notFound('Rule not found');
    const [resource] = await this.repo.resourcesByIds([input.resourceId]);
    if (!resource) throw AppError.notFound('Resource not found');
    const expiresAt = input.expiresAt ? new Date(input.expiresAt.length === 10 ? `${input.expiresAt}T23:59:59Z` : input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw AppError.badRequest('The expiry date must be in the future.');
    const row = await this.repo.upsertExemption({
      ruleId: input.ruleId,
      resourceId: input.resourceId,
      reason: input.reason,
      expiresAt,
      createdById: actor?.id ?? null,
      createdBy: actor?.name ?? null,
    });
    await this.repo.setResultExempt(input.ruleId, input.resourceId, true);
    this.invalidate();
    return exemptionDto(row);
  }

  /** One reason and end date for several resources (everything is validated before anything is written). */
  async createExemptions(input: BulkExemptionRequest, actor: AuditActor | null): Promise<{ created: number }> {
    const rule = await this.repo.getRule(input.ruleId);
    if (!rule) throw AppError.notFound('Rule not found');
    const resources = await this.repo.resourcesByIds(input.resourceIds);
    if (resources.length !== new Set(input.resourceIds).size) throw AppError.notFound('Some of those resources no longer exist');
    const expiresAt = input.expiresAt ? new Date(input.expiresAt.length === 10 ? `${input.expiresAt}T23:59:59Z` : input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw AppError.badRequest('The expiry date must be in the future.');
    for (const r of resources) {
      await this.repo.upsertExemption({
        ruleId: input.ruleId,
        resourceId: r.id,
        reason: input.reason,
        expiresAt,
        createdById: actor?.id ?? null,
        createdBy: actor?.name ?? null,
      });
      await this.repo.setResultExempt(input.ruleId, r.id, true);
    }
    this.invalidate();
    return { created: resources.length };
  }

  async deleteExemption(id: string): Promise<ExemptionDto> {
    const row = await this.repo.getExemption(id);
    if (!row) throw AppError.notFound('Exemption not found');
    await this.repo.deleteExemption(id);
    await this.repo.setResultExempt(row.ruleId, row.resourceId, false);
    this.invalidate();
    return exemptionDto(row);
  }
}

const NO_LEGACY = { field: null, operator: null, value: null, tagKey: null, appliesToType: null };

function cleanScope(scope: RuleScope | undefined): RuleScope | null {
  if (!scope) return null;
  const out: RuleScope = {};
  if (scope.types?.length) out.types = scope.types.map((t) => t.toLowerCase());
  if (scope.locations?.length) out.locations = scope.locations;
  if (scope.subscriptionIds?.length) out.subscriptionIds = scope.subscriptionIds;
  if (scope.resourceGroupIds?.length) out.resourceGroupIds = scope.resourceGroupIds;
  if (scope.tagKey?.trim()) {
    out.tagKey = scope.tagKey.trim();
    if (scope.tagValues?.length) out.tagValues = scope.tagValues;
  }
  return Object.keys(out).length ? out : null;
}

function validateDefinition(def: RuleDefinition): void {
  for (const [i, c] of def.conditions.entries()) {
    const n = `Condition ${i + 1}`;
    if ((c.field === 'tag' || c.field === 'property') && !c.key?.trim()) {
      throw AppError.badRequest(`${n}: ${c.field === 'tag' ? 'which tag?' : 'which property path?'}`);
    }
    if (!VALUELESS_OPERATORS.includes(c.operator) && !c.value?.trim()) throw AppError.badRequest(`${n}: needs a value.`);
    if (['gt', 'gte', 'lt', 'lte'].includes(c.operator)) {
      if (!Number.isFinite(Number(c.value))) throw AppError.badRequest(`${n}: needs a number.`);
      if (!NUMERIC_FIELDS.includes(c.field) && c.field !== 'property') throw AppError.badRequest(`${n}: ${c.field} isn’t numeric.`);
    }
    if (c.operator === 'matches' && !safeRegex(c.value ?? '')) throw AppError.badRequest(`${n}: invalid regular expression.`);
  }
}
