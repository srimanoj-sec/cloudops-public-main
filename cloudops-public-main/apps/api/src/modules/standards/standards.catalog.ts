import {
  NUMERIC_FIELDS,
  type RuleCondition,
  type RuleDefinition,
  type RuleScope,
  type RuleTemplateDto,
  type StandardSeverity,
} from '@cloudops/core';
import {
  RULE_LIBRARY,
  TEMPLATES,
  prop,
  safeRegex,
  tagValue,
  type EvalContext,
  type EvalResource,
  type Params,
  type Verdict,
} from './standards.library.js';

export type { EvalContext, EvalResource, Verdict } from './standards.library.js';

/**
 * Built-in standards ("packs"): curated sets of library rules, enabled for
 * everyone. Keys are stable — they carry users' enable/disable choices and
 * parameters across upgrades. Opinionated rules ship disabled.
 */
export interface BuiltinStandardDef {
  key: string;
  name: string;
  description: string;
  rules: { key: string; enabled?: boolean }[];
}

export const BUILTIN_STANDARDS: BuiltinStandardDef[] = [
  {
    key: 'security',
    name: 'Security Baseline',
    description: 'Encryption in transit, public exposure, secret and identity hygiene — the Azure security benchmark essentials.',
    rules: [
      { key: 'https-only' },
      { key: 'storage-secure-transfer' },
      { key: 'min-tls-1-2' },
      { key: 'storage-no-public-blob' },
      { key: 'public-network-restricted' },
      { key: 'vm-no-public-ip' },
      { key: 'keyvault-soft-delete' },
      { key: 'keyvault-purge-protection' },
      { key: 'keyvault-rbac' },
      { key: 'acr-admin-disabled' },
      { key: 'redis-tls-only' },
      { key: 'managed-identity' },
      { key: 'local-auth-disabled', enabled: false },
    ],
  },
  {
    key: 'cost',
    name: 'Cost Optimization',
    description: 'Resources you pay for but don’t use — orphaned disks, IPs and NICs, idle plans, VMs stopped without deallocating.',
    rules: [
      { key: 'unattached-disk' },
      { key: 'unassociated-public-ip' },
      { key: 'orphaned-nic' },
      { key: 'vm-stopped-not-deallocated' },
      { key: 'empty-app-service-plan' },
      { key: 'plan-apps-all-stopped' },
    ],
  },
  {
    key: 'reliability',
    name: 'Reliability',
    description: 'Production workloads survive a zone or instance failure. Judged only for resources tagged as production.',
    rules: [{ key: 'postgres-ha' }, { key: 'db-geo-backup' }, { key: 'storage-redundancy' }, { key: 'app-plan-multi-instance' }],
  },
  {
    key: 'tagging',
    name: 'Tagging & Ownership',
    description: 'Every resource is attributable to an owner, an environment and a cost centre.',
    rules: [{ key: 'owner-present' }, { key: 'has-tags' }, { key: 'env-tag' }, { key: 'required-tags', enabled: false }],
  },
  {
    key: 'naming',
    name: 'Naming Conventions',
    description: 'Names are clean, portable and tell you what the resource is.',
    rules: [{ key: 'no-spaces' }, { key: 'valid-length' }, { key: 'caf-prefix', enabled: false }],
  },
  {
    key: 'lifecycle',
    name: 'Lifecycle Hygiene',
    description: 'Resources are retired deliberately, not forgotten.',
    rules: [{ key: 'not-deprecated' }, { key: 'idle-has-retire-date' }, { key: 'retire-date-passed' }],
  },
  {
    key: 'governance',
    name: 'Governance & Visibility',
    description: 'Resources are placed in approved regions and visible in cost reporting.',
    rules: [{ key: 'has-location' }, { key: 'cost-visibility' }, { key: 'allowed-locations', enabled: false }],
  },
  {
    key: 'operations',
    name: 'Operations',
    description: 'Monitoring and operational tooling is on supported, current configurations.',
    rules: [{ key: 'appinsights-workspace-based' }],
  },
];

/** Built-in standard a library rule ships in (for the library listing). */
const BUILTIN_OF = new Map<string, { standard: string; enabled: boolean }>();
for (const std of BUILTIN_STANDARDS) {
  for (const r of std.rules) BUILTIN_OF.set(r.key, { standard: std.key, enabled: r.enabled ?? true });
}

export function libraryDtos(): RuleTemplateDto[] {
  return RULE_LIBRARY.map((t) => ({
    key: t.key,
    name: t.name,
    category: t.category,
    severity: t.severity,
    description: t.description,
    remediation: t.remediation,
    appliesTo: t.appliesTo,
    appliesToTypes: t.types,
    params: t.params ?? [],
    builtinStandard: BUILTIN_OF.get(t.key)?.standard ?? null,
    enabledByDefault: BUILTIN_OF.get(t.key)?.enabled ?? true,
  }));
}

/** Template defaults overlaid with a rule's saved parameters. */
export function mergedParams(templateKey: string, saved: unknown): Params {
  const t = TEMPLATES.get(templateKey);
  const out: Params = {};
  for (const spec of t?.params ?? []) if (spec.default !== undefined) out[spec.key] = spec.default;
  if (saved && typeof saved === 'object') Object.assign(out, saved as Params);
  return out;
}

/** Required template parameters that are missing/empty (a rule can't run without them). */
export function missingParams(templateKey: string, params: Params): string[] {
  const t = TEMPLATES.get(templateKey);
  return (t?.params ?? [])
    .filter((s) => s.required)
    .filter((s) => {
      const v = params[s.key];
      return v == null || v === '' || (Array.isArray(v) && v.length === 0);
    })
    .map((s) => s.label);
}

// ── Scope ──────────────────────────────────────────────────────────

export function inScope(scope: RuleScope | null | undefined, r: EvalResource): boolean {
  if (!scope) return true;
  if (scope.types?.length && !scope.types.some((t) => t.toLowerCase() === r.type)) return false;
  if (scope.locations?.length && !scope.locations.some((l) => l.toLowerCase() === (r.location ?? '').toLowerCase())) return false;
  if (scope.subscriptionIds?.length && !(r.subscriptionId && scope.subscriptionIds.includes(r.subscriptionId))) return false;
  if (scope.resourceGroupIds?.length && !(r.resourceGroupId && scope.resourceGroupIds.includes(r.resourceGroupId))) return false;
  if (scope.tagKey) {
    const v = tagValue(r, scope.tagKey);
    if (v == null) return false;
    if (scope.tagValues?.length && !scope.tagValues.some((x) => x.toLowerCase() === v.toLowerCase())) return false;
  }
  return true;
}

export function describeScope(scope: RuleScope | null | undefined): string | null {
  if (!scope) return null;
  const parts: string[] = [];
  if (scope.types?.length) parts.push(scope.types.map((t) => t.replace(/^microsoft\./i, '')).join(', '));
  if (scope.locations?.length) parts.push(`in ${scope.locations.join(', ')}`);
  if (scope.subscriptionIds?.length) parts.push(`${scope.subscriptionIds.length} subscription(s)`);
  if (scope.resourceGroupIds?.length) parts.push(`${scope.resourceGroupIds.length} resource group(s)`);
  if (scope.tagKey) parts.push(scope.tagValues?.length ? `tagged ${scope.tagKey} = ${scope.tagValues.join(' | ')}` : `tagged ${scope.tagKey}`);
  return parts.length ? parts.join(' · ') : null;
}

// ── Custom conditions ──────────────────────────────────────────────

function fieldValue(c: RuleCondition, r: EvalResource, ctx: EvalContext): string | number | boolean | null {
  switch (c.field) {
    case 'name':
      return r.name;
    case 'type':
      return r.type;
    case 'location':
      return r.location;
    case 'sku':
      return r.sku;
    case 'owner':
      return r.owner;
    case 'lifecycleStage':
      return r.lifecycleStage;
    case 'resourceGroup':
      return r.resourceGroupName;
    case 'subscription':
      return r.subscriptionName;
    case 'tag':
      return c.key ? tagValue(r, c.key) : null;
    case 'tagCount':
      return Object.keys(r.tags).length;
    case 'property': {
      const v = c.key ? prop(r, c.key) : undefined;
      if (v == null) return null;
      return typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean);
    }
    case 'costMonthly':
      return r.costMonthly;
    case 'ageDays':
      return Math.floor((ctx.now.getTime() - r.createdAt.getTime()) / 86_400_000);
    default:
      return null;
  }
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

function label(c: RuleCondition): string {
  if (c.field === 'tag') return `tag "${c.key}"`;
  if (c.field === 'property') return `property ${c.key}`;
  return c.field;
}

/** One condition → true/false, plus a human detail for failures. */
export function evaluateCondition(c: RuleCondition, r: EvalResource, ctx: EvalContext): { ok: boolean; detail: string } {
  const raw = fieldValue(c, r, ctx);
  const present = raw !== null && raw !== undefined && raw !== '';
  const text = present ? String(raw) : '';
  const t = text.toLowerCase();
  const want = (c.value ?? '').toLowerCase();
  const shown = present ? `${label(c)} = "${text}"` : `${label(c)} is not set`;
  const num = Number(raw);
  const target = Number(c.value);
  const numeric = NUMERIC_FIELDS.includes(c.field) || (present && Number.isFinite(num) && Number.isFinite(target));
  switch (c.operator) {
    case 'exists':
      return { ok: present, detail: `${label(c)} is not set` };
    case 'not_exists':
      return { ok: !present, detail: shown };
    case 'equals':
      return { ok: present && t === want, detail: shown };
    case 'not_equals':
      return { ok: !(present && t === want), detail: shown };
    case 'contains':
      return { ok: present && t.includes(want), detail: shown };
    case 'not_contains':
      return { ok: !(present && t.includes(want)), detail: shown };
    case 'starts_with':
      return { ok: present && t.startsWith(want), detail: shown };
    case 'ends_with':
      return { ok: present && t.endsWith(want), detail: shown };
    case 'matches': {
      const re = safeRegex(c.value ?? '', 'i');
      if (!re) return { ok: true, detail: '' }; // invalid pattern never fails resources
      return { ok: present && re.test(text), detail: shown };
    }
    case 'in':
      return { ok: present && list(c.value).includes(t), detail: shown };
    case 'not_in':
      return { ok: !(present && list(c.value).includes(t)), detail: shown };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (!present || !numeric || !Number.isFinite(num) || !Number.isFinite(target)) return { ok: false, detail: shown };
      const ok = c.operator === 'gt' ? num > target : c.operator === 'gte' ? num >= target : c.operator === 'lt' ? num < target : num <= target;
      return { ok, detail: shown };
    }
    case 'is_true':
      return { ok: raw === true || t === 'true' || t === 'enabled', detail: shown };
    case 'is_false':
      return { ok: raw === false || t === 'false' || t === 'disabled', detail: shown };
    default:
      return { ok: true, detail: '' };
  }
}

export function evaluateDefinition(def: RuleDefinition, r: EvalResource, ctx: EvalContext): Verdict {
  const results = def.conditions.map((c) => evaluateCondition(c, r, ctx));
  if (def.match === 'any') {
    const ok = results.some((x) => x.ok);
    return { passed: ok, detail: ok ? undefined : results.map((x) => x.detail).filter(Boolean).join('; ') };
  }
  const failed = results.filter((x) => !x.ok);
  return { passed: failed.length === 0, detail: failed.map((x) => x.detail).filter(Boolean).join('; ') || undefined };
}

export function describeDefinition(def: RuleDefinition, labels: Record<string, string>): string {
  const parts = def.conditions.map((c) => {
    const valueless = ['exists', 'not_exists', 'is_true', 'is_false'].includes(c.operator);
    return `${label(c)} ${labels[c.operator] ?? c.operator}${valueless ? '' : ` ${c.value ?? ''}`}`.trim();
  });
  return parts.join(def.match === 'any' ? ' OR ' : ' AND ');
}

// ── Legacy (pre-v2) single-condition custom rules ──────────────────

export interface LegacyRule {
  field: string | null;
  operator: string | null;
  value: string | null;
  tagKey: string | null;
  appliesToType: string | null;
}

/** Convert a legacy custom rule to a v2 definition + scope (type substring kept as its own check). */
export function legacyToDefinition(rule: LegacyRule): RuleDefinition | null {
  if (!rule.field || !rule.operator) return null;
  const field = rule.field === 'cost' ? 'costMonthly' : (rule.field as RuleCondition['field']);
  return {
    match: 'all',
    conditions: [
      {
        field,
        operator: rule.operator as RuleCondition['operator'],
        key: rule.field === 'tag' ? (rule.tagKey ?? undefined) : undefined,
        value: rule.value ?? undefined,
      },
    ],
  };
}

// ── One entry point for every rule kind ────────────────────────────

export interface EvaluableRule extends LegacyRule {
  source: string;
  template: string | null;
  params: unknown;
  definition: unknown;
  scope: unknown;
}

/**
 * The verdict of a rule for a resource, or null when the rule doesn't apply
 * (out of scope, wrong type, not enough information, misconfigured rule).
 */
export function evaluateRule(rule: EvaluableRule, r: EvalResource, ctx: EvalContext): Verdict {
  if (!inScope(rule.scope as RuleScope | null, r)) return null;
  // Legacy type-substring filter.
  if (rule.appliesToType && !r.type.includes(rule.appliesToType.toLowerCase())) return null;

  if (rule.template) {
    const t = TEMPLATES.get(rule.template);
    if (!t) return null;
    if (t.types && !t.types.includes(r.type)) return null;
    const params = mergedParams(rule.template, rule.params);
    if (missingParams(rule.template, params).length) return null;
    return t.evaluate(r, params, ctx);
  }
  const def = (rule.definition as RuleDefinition | null) ?? legacyToDefinition(rule);
  return def ? evaluateDefinition(def, r, ctx) : null;
}

/** Default severity of a built-in rule (from the library). */
export function builtinSeverity(key: string): StandardSeverity {
  return TEMPLATES.get(key)?.severity ?? 'low';
}
