import { z } from 'zod';

/**
 * Standards & governance contracts. A `Standard` groups `StandardRule`s; each rule
 * is auto-evaluated against every resource it APPLIES to, producing
 * `ComplianceResult`s (pass / fail / exempt) that roll up into weighted scores.
 *
 * Rules come in three kinds:
 *  - built-in  — a rule from the library, living in a built-in standard (pack);
 *  - template  — a library rule added to a custom standard, with its own
 *                parameters and scope;
 *  - conditions — a custom rule assembled from field/operator/value conditions.
 * A rule that does not apply to a resource (wrong type, out of scope, nothing to
 * judge) records nothing for it — "not applicable" is neither pass nor fail.
 */

export const STANDARD_SEVERITIES = ['high', 'medium', 'low'] as const;
export type StandardSeverity = (typeof STANDARD_SEVERITIES)[number];

/** Severity weights for the weighted compliance score. */
export const SEVERITY_WEIGHT: Record<StandardSeverity, number> = { high: 3, medium: 2, low: 1 };

/** Well-Architected-style pillars every rule belongs to. */
export const RULE_CATEGORIES = ['security', 'cost', 'reliability', 'tagging', 'naming', 'governance', 'operations'] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];
export const RULE_CATEGORY_LABELS: Record<RuleCategory, string> = {
  security: 'Security',
  cost: 'Cost optimization',
  reliability: 'Reliability',
  tagging: 'Tagging & ownership',
  naming: 'Naming',
  governance: 'Governance & lifecycle',
  operations: 'Operations',
};

// ── Rule library (templates) ───────────────────────────────────────

export type RuleParamKind = 'string' | 'stringList' | 'number' | 'regex' | 'tagKey' | 'locations' | 'types' | 'boolean';

export interface RuleParamSpec {
  key: string;
  label: string;
  kind: RuleParamKind;
  required?: boolean;
  default?: unknown;
  help?: string;
  placeholder?: string;
}

/** A rule in the library: what it checks, where it applies, how to fix a failure. */
export interface RuleTemplateDto {
  key: string;
  name: string;
  category: RuleCategory;
  severity: StandardSeverity;
  /** What is checked and why it matters. */
  description: string;
  /** How to fix a failing resource. */
  remediation: string;
  /** Human summary of the resources it applies to ("Storage accounts, SQL servers…"). */
  appliesTo: string;
  /** Lower-cased resource types it applies to; null = every resource. */
  appliesToTypes: string[] | null;
  params: RuleParamSpec[];
  /** The built-in standard it ships in (null = library-only). */
  builtinStandard: string | null;
  enabledByDefault: boolean;
}

// ── Custom conditions ──────────────────────────────────────────────

/** Resource fields a condition can test. `tag` and `property` take a `key` (tag name / property path). */
export const CONDITION_FIELDS = [
  'name',
  'type',
  'location',
  'sku',
  'owner',
  'lifecycleStage',
  'resourceGroup',
  'subscription',
  'tag',
  'tagCount',
  'property',
  'costMonthly',
  'ageDays',
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const CONDITION_FIELD_LABELS: Record<ConditionField, string> = {
  name: 'Name',
  type: 'Resource type',
  location: 'Region',
  sku: 'SKU',
  owner: 'Owner',
  lifecycleStage: 'Lifecycle stage',
  resourceGroup: 'Resource group',
  subscription: 'Subscription',
  tag: 'Tag value',
  tagCount: 'Number of tags',
  property: 'Configuration property',
  costMonthly: 'Monthly cost',
  ageDays: 'Age (days since created)',
};

/** Numeric fields accept comparison operators; the rest are text. */
export const NUMERIC_FIELDS: readonly ConditionField[] = ['tagCount', 'costMonthly', 'ageDays'];

export const CONDITION_OPERATORS = [
  'exists',
  'not_exists',
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'matches',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_true',
  'is_false',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const CONDITION_OPERATOR_LABELS: Record<ConditionOperator, string> = {
  exists: 'is set',
  not_exists: 'is not set',
  equals: 'equals',
  not_equals: 'does not equal',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  matches: 'matches regex',
  in: 'is one of',
  not_in: 'is not one of',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  is_true: 'is true',
  is_false: 'is false',
};

/** Operators that take no value. */
export const VALUELESS_OPERATORS: readonly ConditionOperator[] = ['exists', 'not_exists', 'is_true', 'is_false'];

export const ruleConditionSchema = z.object({
  field: z.enum(CONDITION_FIELDS),
  operator: z.enum(CONDITION_OPERATORS),
  /** Tag name (field=tag) or dotted property path (field=property, e.g. `networkAcls.defaultAction`). */
  key: z.string().trim().max(200).optional(),
  value: z.string().trim().max(500).optional(),
});
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

export const ruleDefinitionSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(ruleConditionSchema).min(1).max(10),
});
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;

/** Which resources a rule is evaluated against (every set filter must match). */
export const ruleScopeSchema = z.object({
  types: z.array(z.string().max(200)).max(100).optional(),
  locations: z.array(z.string().max(100)).max(100).optional(),
  subscriptionIds: z.array(z.string().max(100)).max(100).optional(),
  resourceGroupIds: z.array(z.string().max(100)).max(200).optional(),
  /** Only resources carrying this tag (optionally with one of `tagValues`). */
  tagKey: z.string().max(200).optional(),
  tagValues: z.array(z.string().max(200)).max(50).optional(),
});
export type RuleScope = z.infer<typeof ruleScopeSchema>;

const ruleParamsSchema = z.record(z.unknown()).optional();

// ── Scores & results ───────────────────────────────────────────────

export interface RuleScoreDto {
  id: string; // StandardRule db id (for drilldown / edit)
  key: string;
  name: string; // custom label, or the built-in description
  description: string;
  severity: string;
  source: string; // 'builtin' | 'custom'
  enabled: boolean;
  category: RuleCategory | null;
  /** How to fix a failure. */
  remediation: string | null;
  /** Library template this rule instantiates (built-in and template rules). */
  template: string | null;
  params: Record<string, unknown> | null;
  definition: RuleDefinition | null;
  scope: RuleScope | null;
  /** Human summary of what it applies to. */
  appliesTo: string | null;
  // Legacy single-condition config (pre-v2 custom rules; null otherwise).
  field: string | null;
  operator: string | null;
  value: string | null;
  tagKey: string | null;
  appliesToType: string | null;
  passed: number;
  failed: number;
  /** Failing resources with an active exemption (excluded from the score). */
  exempt: number;
}

export interface StandardScoreDto {
  id: string; // Standard db id (for adding rules / delete)
  key: string;
  name: string;
  description: string | null;
  source: string; // 'builtin' | 'custom'
  checks: number;
  passed: number;
  failed: number;
  exempt: number;
  score: number; // 0..100 weighted
  rules: RuleScoreDto[];
}

export interface CategoryScoreDto {
  category: RuleCategory;
  label: string;
  score: number;
  passed: number;
  failed: number;
}

export interface StandardsSummaryDto {
  evaluatedAt: string | null;
  resourcesEvaluated: number;
  totalChecks: number;
  passed: number;
  failed: number;
  exempt: number;
  score: number; // 0..100 weighted overall compliance
  standards: StandardScoreDto[];
  bySeverity: { severity: string; failed: number }[];
  byCategory: CategoryScoreDto[];
}

/** The background compliance evaluation: what's running, and how the last one went. */
export interface EvaluationStatusDto {
  state: 'idle' | 'queued' | 'running';
  /** Why the current one was started ("manual", "after inventory sync"…). */
  reason: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  last: {
    finishedAt: string;
    durationMs: number | null;
    ok: boolean;
    error: string | null;
    reason: string;
    score: number | null;
    failed: number | null;
  } | null;
}

export interface ExemptionDto {
  id: string;
  ruleId: string;
  resourceId: string;
  reason: string;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
  /** Register fields (the exemptions list) — names and state, so nothing is hidden. */
  resourceName?: string;
  ruleName?: string;
  standardName?: string;
  severity?: string;
  /** active · expiring (≤ 14 days) · expired · permanent (no end date). */
  status?: 'active' | 'expiring' | 'expired' | 'permanent';
}

/** One rule's verdict for one resource (drilldown / per-resource compliance). */
export interface ComplianceResultDto {
  id: string;
  ruleId: string;
  ruleKey: string;
  ruleDescription: string;
  standardKey: string;
  severity: string;
  scopeType: string;
  scopeId: string;
  scopeName: string | null;
  /** Where the resource lives and what it is, for context in the drilldown. */
  resourceType: string | null;
  resourceGroup: string | null;
  subscription: string | null;
  passed: boolean;
  exempt: boolean;
  exemption: ExemptionDto | null;
  detail: string | null;
  evaluatedAt: string;
}

export interface ResourceComplianceDto {
  resourceId: string;
  score: number; // 0..100 weighted
  passed: number;
  failed: number;
  exempt: number;
  results: {
    ruleId: string;
    ruleKey: string;
    ruleName: string;
    standardKey: string;
    standardName: string;
    /** Library template (lets the UI offer the remediation that fixes it). */
    template: string | null;
    category: RuleCategory | null;
    description: string;
    remediation: string | null;
    severity: string;
    passed: boolean;
    exempt: boolean;
    exemption: ExemptionDto | null;
    detail: string | null;
  }[];
}

export const complianceResultsQuerySchema = z.object({
  ruleId: z.string().optional(),
  standardKey: z.string().optional(),
  passed: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1')),
});
export type ComplianceResultsQuery = z.infer<typeof complianceResultsQuerySchema>;

// ── Custom standards & rules (user-authored) ──────────────────────

export const createStandardSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  /** Start with these library rules (template keys), using their defaults. */
  templates: z.array(z.string().max(100)).max(100).optional(),
});
export type CreateStandardRequest = z.infer<typeof createStandardSchema>;

// Legacy (pre-v2) single-condition rule fields — still accepted.
/** @deprecated use CONDITION_FIELDS */
export const RULE_FIELDS = ['tag', 'name', 'type', 'location', 'owner', 'lifecycleStage', 'cost'] as const;
export type RuleField = (typeof RULE_FIELDS)[number];
/** @deprecated use CONDITION_OPERATORS */
export const RULE_OPERATORS = ['exists', 'not_exists', 'equals', 'not_equals', 'matches', 'in', 'not_in'] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];
/** @deprecated use CONDITION_OPERATOR_LABELS */
export const RULE_OPERATOR_LABELS: Record<RuleOperator, string> = {
  exists: 'exists / is set',
  not_exists: 'is not set',
  equals: 'equals',
  not_equals: 'does not equal',
  matches: 'matches regex',
  in: 'is one of',
  not_in: 'is not one of',
};

/**
 * Create a rule in a custom standard: from a library template (with params), or
 * from conditions. Legacy single-condition payloads (field/operator/value/tagKey/
 * appliesToType) are still accepted and converted.
 */
export const createRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  severity: z.enum(STANDARD_SEVERITIES).default('medium'),
  category: z.enum(RULE_CATEGORIES).optional(),
  remediation: z.string().trim().max(1000).optional(),
  template: z.string().max(100).optional(),
  params: ruleParamsSchema,
  definition: ruleDefinitionSchema.optional(),
  scope: ruleScopeSchema.optional(),
  // legacy
  field: z.enum(RULE_FIELDS).optional(),
  operator: z.enum(RULE_OPERATORS).optional(),
  value: z.string().trim().max(500).optional(),
  tagKey: z.string().trim().max(100).optional(),
  appliesToType: z.string().trim().max(200).optional(),
});
export type CreateRuleRequest = z.infer<typeof createRuleSchema>;

/** Built-in rules: `enabled`, `severity` and `params` are editable. Custom rules: everything. */
export const updateRuleSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  severity: z.enum(STANDARD_SEVERITIES).optional(),
  enabled: z.boolean().optional(),
  category: z.enum(RULE_CATEGORIES).optional(),
  remediation: z.string().trim().max(1000).nullable().optional(),
  params: z.record(z.unknown()).nullable().optional(),
  definition: ruleDefinitionSchema.nullable().optional(),
  scope: ruleScopeSchema.nullable().optional(),
  // legacy
  field: z.enum(RULE_FIELDS).optional(),
  operator: z.enum(RULE_OPERATORS).optional(),
  value: z.string().trim().max(500).nullable().optional(),
  tagKey: z.string().trim().max(100).nullable().optional(),
  appliesToType: z.string().trim().max(200).nullable().optional(),
});
export type UpdateRuleRequest = z.infer<typeof updateRuleSchema>;

/** Dry-run a rule against the current inventory before saving it. */
export const previewRuleSchema = createRuleSchema.omit({ name: true }).extend({ name: z.string().max(120).optional() });
export type PreviewRuleRequest = z.infer<typeof previewRuleSchema>;

export interface RulePreviewDto {
  /** Active resources considered. */
  resources: number;
  /** Resources the rule applies to (in scope and judgeable). */
  applicable: number;
  passed: number;
  failed: number;
  /** A sample of verdicts, failures first. */
  samples: { id: string; name: string; type: string; resourceGroup: string | null; passed: boolean; detail: string | null }[];
}

export const createExemptionSchema = z.object({
  ruleId: z.string().min(1),
  resourceId: z.string().min(1),
  reason: z.string().trim().min(3, 'Say why this resource is exempt').max(500),
  /** Optional end date (ISO). Expired exemptions stop applying at the next evaluation. */
  expiresAt: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
});
export type CreateExemptionRequest = z.infer<typeof createExemptionSchema>;

/** Exempt several resources from one rule with one reason and end date. */
export const bulkExemptionSchema = z.object({
  ruleId: z.string().min(1),
  resourceIds: z.array(z.string().min(1).max(64)).min(1).max(500),
  reason: z.string().trim().min(3, 'Say why these resources are exempt').max(500),
  expiresAt: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
});
export type BulkExemptionRequest = z.infer<typeof bulkExemptionSchema>;
