import {
  formatMoney,
  type AutomationConditions,
  type AutomationMatchDto,
  type BudgetStatusDto,
  type CostAnomalyDto,
} from '@cloudops/core';

/**
 * Pure translation of "what happened" into rule matches, and of a rule's
 * conditions into a filter. Shared by the live engine (events) and the preview
 * (today's data), so both always agree on what a rule matches.
 */

const SEVERITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const MAX_RESOURCES = 50;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export interface ComplianceFailure {
  ruleId: string;
  ruleName: string;
  severity: string;
  /** Resources failing (for live events: newly failing). */
  resourceIds: string[];
  /** When resource ids aren't at hand (preview), how many are failing. */
  count?: number;
}

export function complianceMatches(
  failures: ComplianceFailure[],
  c: AutomationConditions,
  isNew: boolean,
): AutomationMatchDto[] {
  const min = c.minSeverity ? SEVERITY_RANK[c.minSeverity]! : 0;
  return failures
    .filter((f) => (SEVERITY_RANK[f.severity] ?? 0) >= min)
    .filter((f) => !c.ruleIds?.length || c.ruleIds.includes(f.ruleId))
    .filter((f) => (f.count ?? f.resourceIds.length) >= (c.minResources ?? 1))
    .map((f) => {
      const n = f.count ?? f.resourceIds.length;
      return {
        key: `compliance:${f.ruleId}`,
        title: f.ruleName,
        detail: isNew
          ? `${plural(n, 'resource')} started failing this check.`
          : `${plural(n, 'resource')} failing this check.`,
        severity: f.severity,
        link: `/standards?rule=${f.ruleId}`,
        resourceIds: f.resourceIds.slice(0, MAX_RESOURCES),
      };
    });
}

const KIND_LABEL: Record<string, string> = {
  spike: 'Cost spike',
  'new-resource': 'New spend',
  'new-region': 'New region spend',
};

export function anomalyMatches(
  anomalies: CostAnomalyDto[],
  c: AutomationConditions,
  currency: string,
): AutomationMatchDto[] {
  return anomalies
    .filter((a) => a.monthlyImpact >= (c.minMonthlyImpact ?? 0))
    .filter((a) => !c.anomalyKinds?.length || c.anomalyKinds.includes(a.kind))
    .map((a) => ({
      key: `cost:${a.kind}:${a.externalId}`,
      title: `${KIND_LABEL[a.kind] ?? a.kind}: ${a.name}`,
      detail: `${a.reason} About ${formatMoney(a.monthlyImpact, currency)}/month if it persists.`,
      severity: 'medium',
      link: a.resourceId ? `/inventory/${a.resourceId}?tab=Cost` : '/finops?tab=anomalies',
      resourceIds: a.resourceId ? [a.resourceId] : [],
    }));
}

export function budgetMatches(
  budgets: BudgetStatusDto[],
  c: AutomationConditions,
  currency: string,
  month: string,
): AutomationMatchDto[] {
  return budgets
    .filter((b) => b.status === 'over' || (b.status === 'at-risk' && c.budgetStatus !== 'over'))
    .map((b) => ({
      // Once per budget per month: a work item raised for May isn't re-raised on every sync.
      key: `budget:${b.id}:${month}`,
      title: `Budget “${b.name}” ${b.status === 'over' ? 'exceeded' : 'at risk'}`,
      detail: `${formatMoney(b.spent, currency)} of ${formatMoney(b.amount, currency)} spent (${Math.round(b.percentUsed)}%); forecast ${formatMoney(b.forecast, currency)} (${Math.round(b.forecastPercent)}%) for ${b.scopeName}.`,
      severity: b.status === 'over' ? 'high' : 'medium',
      link: '/finops?tab=budgets',
      resourceIds: [],
    }));
}

export interface DriftChange {
  resourceId: string;
  field: string;
}

/** One match per changed field in a sync run. */
export function driftMatches(
  runId: string,
  changes: DriftChange[],
  c: AutomationConditions,
): AutomationMatchDto[] {
  const byField = new Map<string, Set<string>>();
  for (const ch of changes) {
    if (c.fields?.length && !c.fields.includes(ch.field)) continue;
    const set = byField.get(ch.field) ?? new Set<string>();
    set.add(ch.resourceId);
    byField.set(ch.field, set);
  }
  return [...byField.entries()]
    .filter(([, ids]) => ids.size >= (c.minResources ?? 1))
    .map(([field, ids]) => ({
      key: `drift:${field}:${runId}`,
      title: `${plural(ids.size, 'resource')} had ${field} changed outside CloudOps`,
      detail: `Found by a sync. Review who changed it and whether to restore it.`,
      severity: field === 'state' ? 'medium' : 'low',
      link: `/operations/drift?run=${runId}&field=${encodeURIComponent(field)}`,
      resourceIds: [...ids].slice(0, MAX_RESOURCES),
    }));
}

export function syncFailedMatch(runId: string, error: string): AutomationMatchDto {
  return {
    key: `sync.failed:${runId}`,
    title: 'Inventory sync failed',
    detail: error.slice(0, 500),
    severity: 'high',
    link: `/operations/syncs?run=${runId}`,
    resourceIds: [],
  };
}

export function unreachableMatches(
  runId: string,
  errors: { account: string; message: string }[],
): AutomationMatchDto[] {
  return errors.map((e) => ({
    // Per organization, not per run: one open work item until someone fixes the credentials.
    key: `sync.unreachable:${e.account}`,
    title: `Organization “${e.account}” could not be reached`,
    detail: `${e.message} Its resources were not refreshed (sync ${runId}).`,
    severity: 'high',
    link: '/providers',
    resourceIds: [],
  }));
}

export function remediationFailedMatch(
  runId: string,
  title: string,
  status: string,
  summary: { total: number; failed: number; verified: number } | null,
): AutomationMatchDto {
  return {
    key: `remediation:${runId}`,
    title: `Remediation ${status === 'partial' ? 'partly failed' : 'failed'}: ${title}`,
    detail: summary
      ? `${summary.failed} of ${summary.total} resources couldn’t be changed or verified.`
      : 'It did not complete.',
    severity: 'high',
    link: `/remediation/${runId}`,
    resourceIds: [],
  };
}
