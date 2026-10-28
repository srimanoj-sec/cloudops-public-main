import { describe, expect, it } from 'vitest';
import type { BudgetStatusDto, CostAnomalyDto } from '@cloudops/core';
import {
  anomalyMatches,
  budgetMatches,
  complianceMatches,
  driftMatches,
  unreachableMatches,
} from './matchers.js';

const failure = (ruleId: string, severity: string, n: number) => ({
  ruleId,
  ruleName: `Rule ${ruleId}`,
  severity,
  resourceIds: Array.from({ length: n }, (_, i) => `${ruleId}-r${i}`),
});

describe('complianceMatches', () => {
  const failures = [failure('a', 'high', 3), failure('b', 'medium', 1), failure('c', 'low', 10)];

  it('keeps everything with no conditions, keyed per rule', () => {
    const m = complianceMatches(failures, {}, true);
    expect(m.map((x) => x.key)).toEqual(['compliance:a', 'compliance:b', 'compliance:c']);
    expect(m[0]!.detail).toBe('3 resources started failing this check.');
    expect(m[0]!.link).toBe('/standards?rule=a');
  });

  it('filters by minimum severity', () => {
    expect(complianceMatches(failures, { minSeverity: 'medium' }, true).map((x) => x.key)).toEqual([
      'compliance:a',
      'compliance:b',
    ]);
    expect(complianceMatches(failures, { minSeverity: 'high' }, true).map((x) => x.key)).toEqual([
      'compliance:a',
    ]);
  });

  it('filters by rule ids and affected count', () => {
    expect(complianceMatches(failures, { ruleIds: ['b', 'c'] }, true).map((x) => x.key)).toEqual([
      'compliance:b',
      'compliance:c',
    ]);
    expect(complianceMatches(failures, { minResources: 3 }, true).map((x) => x.key)).toEqual([
      'compliance:a',
      'compliance:c',
    ]);
  });

  it('uses the count when resource ids are not at hand (preview)', () => {
    const m = complianceMatches(
      [{ ruleId: 'x', ruleName: 'X', severity: 'high', resourceIds: [], count: 7 }],
      { minResources: 5 },
      false,
    );
    expect(m).toHaveLength(1);
    expect(m[0]!.detail).toBe('7 resources failing this check.');
  });

  it('caps the resources linked to a work item', () => {
    expect(complianceMatches([failure('big', 'high', 80)], {}, true)[0]!.resourceIds).toHaveLength(
      50,
    );
  });
});

const anomaly = (over: Partial<CostAnomalyDto>): CostAnomalyDto => ({
  kind: 'spike',
  resourceId: 'r1',
  externalId: '/subs/x/r1',
  name: 'vm-1',
  type: 'microsoft.compute/virtualmachines',
  resourceGroup: 'rg',
  subscription: 'sub',
  location: 'eastus',
  latest: 100,
  baseline: 50,
  expectedLow: 40,
  expectedHigh: 60,
  deltaAbs: 50,
  deltaPct: 100,
  monthlyImpact: 1500,
  band: 100,
  latestDate: '2026-09-27',
  reason: 'Above its expected range.',
  ...over,
});

describe('anomalyMatches', () => {
  const list = [
    anomaly({}),
    anomaly({
      kind: 'new-resource',
      externalId: '/subs/x/r2',
      monthlyImpact: 100,
      resourceId: null,
    }),
  ];

  it('filters by monthly impact and kind', () => {
    expect(anomalyMatches(list, { minMonthlyImpact: 500 }, 'INR')).toHaveLength(1);
    expect(
      anomalyMatches(list, { anomalyKinds: ['new-resource'] }, 'INR').map((m) => m.key),
    ).toEqual(['cost:new-resource:/subs/x/r2']);
  });

  it('links to the resource cost tab, or to the anomalies list when not in inventory', () => {
    const [a, b] = anomalyMatches(list, {}, 'INR');
    expect(a!.link).toBe('/inventory/r1?tab=Cost');
    expect(b!.link).toBe('/finops?tab=anomalies');
    expect(b!.resourceIds).toEqual([]);
  });
});

const budget = (id: string, status: BudgetStatusDto['status']): BudgetStatusDto => ({
  id,
  name: `B ${id}`,
  scopeType: 'all',
  scopeId: null,
  scopeName: 'All spend',
  amount: 1000,
  alertPercent: 80,
  spent: 900,
  forecast: 1200,
  percentUsed: 90,
  forecastPercent: 120,
  status,
});

describe('budgetMatches', () => {
  const list = [budget('a', 'over'), budget('b', 'at-risk'), budget('c', 'ok')];

  it('includes at-risk budgets by default, never ok ones', () => {
    expect(budgetMatches(list, {}, 'INR', '2026-09').map((m) => m.key)).toEqual([
      'budget:a:2026-09',
      'budget:b:2026-09',
    ]);
  });

  it('only over budgets when asked', () => {
    expect(
      budgetMatches(list, { budgetStatus: 'over' }, 'INR', '2026-09').map((m) => m.key),
    ).toEqual(['budget:a:2026-09']);
  });
});

describe('driftMatches', () => {
  const changes = [
    { resourceId: 'r1', field: 'tags' },
    { resourceId: 'r2', field: 'tags' },
    { resourceId: 'r1', field: 'tags' },
    { resourceId: 'r3', field: 'sku' },
  ];

  it('groups by field and counts distinct resources', () => {
    const m = driftMatches('run1', changes, {});
    expect(m.map((x) => [x.key, x.resourceIds.length])).toEqual([
      ['drift:tags:run1', 2],
      ['drift:sku:run1', 1],
    ]);
    expect(m[0]!.link).toBe('/operations/drift?run=run1&field=tags');
  });

  it('filters by field and minimum resources', () => {
    expect(driftMatches('run1', changes, { fields: ['sku'] }).map((x) => x.key)).toEqual([
      'drift:sku:run1',
    ]);
    expect(driftMatches('run1', changes, { minResources: 2 }).map((x) => x.key)).toEqual([
      'drift:tags:run1',
    ]);
  });
});

describe('unreachableMatches', () => {
  it('keys per organization so one work item covers repeated failures', () => {
    const [m] = unreachableMatches('run9', [{ account: 'Contoso', message: 'Bad secret.' }]);
    expect(m!.key).toBe('sync.unreachable:Contoso');
    expect(m!.detail).toContain('run9');
  });
});
