import { describe, expect, it } from 'vitest';
import { BUILTIN_STANDARDS, evaluateRule, inScope, legacyToDefinition, libraryDtos, type EvaluableRule } from './standards.catalog.js';
import { RULE_LIBRARY, TEMPLATES, type EvalContext, type EvalResource } from './standards.library.js';

const SUB = '/subscriptions/s1/resourcegroups/rg1/providers';

function res(overrides: Partial<EvalResource> = {}): EvalResource {
  return {
    id: 'r1',
    externalId: `${SUB}/microsoft.compute/virtualmachines/vm-app-prod-01`,
    name: 'vm-app-prod-01',
    type: 'microsoft.compute/virtualmachines',
    location: 'centralindia',
    sku: null,
    owner: 'platform-team',
    tags: { Owner: 'platform-team', environment: 'prod' },
    lifecycleStage: 'Created',
    inUse: null,
    retireBy: null,
    costDaily: 1,
    costMonthly: 30,
    createdAt: new Date('2026-01-01'),
    properties: {},
    subscriptionId: 'sub-db-id',
    subscriptionName: 'Prod',
    resourceGroupId: 'rg-db-id',
    resourceGroupName: 'rg1',
    ...overrides,
  };
}

function ctx(resources: EvalResource[] = [], costSynced = true): EvalContext {
  const sitesByPlan = new Map<string, EvalResource[]>();
  for (const r of resources) {
    const plan = r.type === 'microsoft.web/sites' ? (r.properties.serverFarmId as string | undefined) : undefined;
    if (plan) sitesByPlan.set(plan.toLowerCase(), [...(sitesByPlan.get(plan.toLowerCase()) ?? []), r]);
  }
  return { now: new Date('2026-09-25'), costSynced, byExternalId: new Map(resources.map((r) => [r.externalId, r])), sitesByPlan };
}

const builtin = (key: string, params: unknown = null): EvaluableRule => ({
  source: 'builtin',
  template: key,
  params,
  definition: null,
  scope: null,
  field: null,
  operator: null,
  value: null,
  tagKey: null,
  appliesToType: null,
});

describe('library integrity', () => {
  it('every built-in standard rule exists in the library', () => {
    for (const std of BUILTIN_STANDARDS) for (const r of std.rules) expect(TEMPLATES.has(r.key), r.key).toBe(true);
  });
  it('keys are unique and every rule explains itself and how to fix it', () => {
    expect(new Set(RULE_LIBRARY.map((t) => t.key)).size).toBe(RULE_LIBRARY.length);
    for (const t of RULE_LIBRARY) {
      expect(t.description.length, t.key).toBeGreaterThan(20);
      expect(t.remediation.length, t.key).toBeGreaterThan(10);
    }
    expect(libraryDtos().length).toBe(RULE_LIBRARY.length);
  });
});

describe('cost-visibility — only judges fixed-price resources', () => {
  const rule = builtin('cost-visibility');
  it('is not applicable before any cost sync', () => {
    expect(evaluateRule(rule, res({ costMonthly: null }), ctx([], false))).toBeNull();
  });
  it('passes with own cost; a running VM with no cost is a data gap', () => {
    expect(evaluateRule(rule, res(), ctx())?.passed).toBe(true);
    expect(evaluateRule(rule, res({ costMonthly: null }), ctx())).toEqual({ passed: false, detail: 'billed by the hour, but no cost reported' });
  });
  it('never judges pay-per-use or free types, web apps (billed via their plan) or brand-new resources', () => {
    for (const type of [
      'microsoft.web/sites',
      'microsoft.automation/automationaccounts/runbooks',
      'microsoft.cognitiveservices/accounts',
      'microsoft.insights/components',
      'microsoft.network/virtualnetworks',
      'mongodb.atlas/organizations',
    ]) {
      expect(evaluateRule(rule, res({ type, costMonthly: null }), ctx()), type).toBeNull();
    }
    expect(evaluateRule(rule, res({ costMonthly: null, createdAt: new Date('2026-09-24') }), ctx())).toBeNull();
  });
  it('skips fixed-price types in a state or tier that isn’t billed', () => {
    const deallocated = res({ costMonthly: null, properties: { extended: { instanceView: { powerState: { code: 'PowerState/deallocated' } } } } });
    expect(evaluateRule(rule, deallocated, ctx())).toBeNull();
    const flexPlan = res({ type: 'microsoft.web/serverfarms', sku: 'FC1', costMonthly: null });
    expect(evaluateRule(rule, flexPlan, ctx())).toBeNull();
    const dedicatedPlan = res({ type: 'microsoft.web/serverfarms', sku: 'B2', costMonthly: null });
    expect(evaluateRule(rule, dedicatedPlan, ctx())?.passed).toBe(false);
  });
  it('passes a database billed through its elastic pool', () => {
    const poolId = `${SUB}/microsoft.sql/servers/sql-1/elasticpools/pool-1`;
    const pool = res({ id: 'p', externalId: poolId, type: 'microsoft.sql/servers/elasticpools', name: 'pool-1', costMonthly: 4000 });
    const db = res({ id: 'd', externalId: `${SUB}/microsoft.sql/servers/sql-1/databases/db-1`, type: 'microsoft.sql/servers/databases', costMonthly: null, properties: { elasticPoolId: poolId } });
    expect(evaluateRule(rule, db, ctx([pool, db]))).toEqual({ passed: true, detail: 'billed through pool-1' });
  });
});

describe('security rules read real ARM properties', () => {
  it('https-only: pass / fail / not applicable when unreported', () => {
    const site = (p: Record<string, unknown>) => res({ type: 'microsoft.web/sites', properties: p });
    expect(evaluateRule(builtin('https-only'), site({ httpsOnly: true }), ctx())?.passed).toBe(true);
    expect(evaluateRule(builtin('https-only'), site({ httpsOnly: false }), ctx())?.passed).toBe(false);
    expect(evaluateRule(builtin('https-only'), site({}), ctx())).toBeNull();
    expect(evaluateRule(builtin('https-only'), res(), ctx())).toBeNull(); // not a web app
  });
  it('min-tls-1-2: storage without the property allows TLS 1.0; SQL without it is unknown', () => {
    const st = (p: Record<string, unknown>) => res({ type: 'microsoft.storage/storageaccounts', properties: p });
    expect(evaluateRule(builtin('min-tls-1-2'), st({ minimumTlsVersion: 'TLS1_2' }), ctx())?.passed).toBe(true);
    expect(evaluateRule(builtin('min-tls-1-2'), st({ minimumTlsVersion: 'TLS1_0' }), ctx())?.passed).toBe(false);
    expect(evaluateRule(builtin('min-tls-1-2'), st({}), ctx())?.passed).toBe(false);
    expect(evaluateRule(builtin('min-tls-1-2'), res({ type: 'microsoft.sql/servers', properties: {} }), ctx())).toBeNull();
    expect(evaluateRule(builtin('min-tls-1-2'), res({ type: 'microsoft.sql/servers', properties: { minimalTlsVersion: '1.2' } }), ctx())?.passed).toBe(true);
  });
  it('public-network-restricted: disabled access or deny-by-default firewall passes', () => {
    const kv = (p: Record<string, unknown>) => res({ type: 'microsoft.keyvault/vaults', properties: p });
    expect(evaluateRule(builtin('public-network-restricted'), kv({ publicNetworkAccess: 'Disabled' }), ctx())?.passed).toBe(true);
    expect(evaluateRule(builtin('public-network-restricted'), kv({ publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Deny' } }), ctx())?.passed).toBe(true);
    expect(evaluateRule(builtin('public-network-restricted'), kv({ publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Allow' } }), ctx())?.passed).toBe(false);
    const pg = res({ type: 'microsoft.dbforpostgresql/flexibleservers', properties: { network: { publicNetworkAccess: 'Enabled' } } });
    expect(evaluateRule(builtin('public-network-restricted'), pg, ctx())?.passed).toBe(false);
  });
  it('vm-no-public-ip follows the VM’s NIC to its IP configuration', () => {
    const nicId = `${SUB}/microsoft.network/networkinterfaces/nic-1`;
    const nic = res({
      id: 'n',
      externalId: nicId,
      type: 'microsoft.network/networkinterfaces',
      name: 'nic-1',
      properties: { ipConfigurations: [{ properties: { publicIPAddress: { id: `${SUB}/microsoft.network/publicipaddresses/pip-1` } } }] },
    });
    const vm = res({ properties: { networkProfile: { networkInterfaces: [{ id: nicId.replace('microsoft.network', 'Microsoft.Network') }] } } });
    expect(evaluateRule(builtin('vm-no-public-ip'), vm, ctx([nic, vm]))).toEqual({ passed: false, detail: 'public IP pip-1 on nic-1' });
    const privateNic = { ...nic, properties: { ipConfigurations: [{ properties: {} }] } };
    expect(evaluateRule(builtin('vm-no-public-ip'), vm, ctx([privateNic, vm]))?.passed).toBe(true);
  });
});

describe('cost-optimization rules', () => {
  it('empty-app-service-plan ignores consumption plans', () => {
    const plan = (sku: string, n: number) => res({ type: 'microsoft.web/serverfarms', sku, properties: { numberOfSites: n } });
    expect(evaluateRule(builtin('empty-app-service-plan'), plan('B1', 0), ctx())?.passed).toBe(false);
    expect(evaluateRule(builtin('empty-app-service-plan'), plan('B1', 2), ctx())?.passed).toBe(true);
    expect(evaluateRule(builtin('empty-app-service-plan'), plan('FC1', 0), ctx())).toBeNull();
  });
  it('plan-apps-all-stopped looks at the plan’s apps', () => {
    const planId = `${SUB}/microsoft.web/serverfarms/asp-1`;
    const plan = res({ externalId: planId, type: 'microsoft.web/serverfarms', sku: 'B2' });
    const app = (state: string, id: string) => res({ id, externalId: `${SUB}/microsoft.web/sites/${id}`, type: 'microsoft.web/sites', properties: { serverFarmId: planId, state } });
    expect(evaluateRule(builtin('plan-apps-all-stopped'), plan, ctx([plan, app('Stopped', 'a'), app('Stopped', 'b')]))?.passed).toBe(false);
    expect(evaluateRule(builtin('plan-apps-all-stopped'), plan, ctx([plan, app('Stopped', 'a'), app('Running', 'b')]))?.passed).toBe(true);
  });
  it('unattached disks and stopped-not-deallocated VMs fail', () => {
    expect(evaluateRule(builtin('unattached-disk'), res({ type: 'microsoft.compute/disks', properties: { diskState: 'Unattached' } }), ctx())?.passed).toBe(false);
    expect(evaluateRule(builtin('unattached-disk'), res({ type: 'microsoft.compute/disks', properties: { diskState: 'Attached' } }), ctx())?.passed).toBe(true);
    const vm = (code: string) => res({ properties: { extended: { instanceView: { powerState: { code } } } } });
    expect(evaluateRule(builtin('vm-stopped-not-deallocated'), vm('PowerState/stopped'), ctx())?.passed).toBe(false);
    expect(evaluateRule(builtin('vm-stopped-not-deallocated'), vm('PowerState/deallocated'), ctx())?.passed).toBe(true);
  });
});

describe('parameters and production gating', () => {
  it('reliability rules only judge production resources by default', () => {
    const pg = (env: string | null) =>
      res({ type: 'microsoft.dbforpostgresql/flexibleservers', tags: env ? { environment: env } : {}, properties: { highAvailability: { mode: 'Disabled' } } });
    expect(evaluateRule(builtin('postgres-ha'), pg('prod'), ctx())?.passed).toBe(false);
    expect(evaluateRule(builtin('postgres-ha'), pg('dev'), ctx())).toBeNull();
    expect(evaluateRule(builtin('postgres-ha'), pg(null), ctx())).toBeNull();
    expect(evaluateRule(builtin('postgres-ha', { productionOnly: false }), pg('dev'), ctx())?.passed).toBe(false);
  });
  it('a rule with a required parameter left empty is not applicable (never fails everything)', () => {
    expect(evaluateRule(builtin('allowed-locations'), res(), ctx())).toBeNull();
    expect(evaluateRule(builtin('allowed-locations', { locations: ['southindia'] }), res(), ctx())?.passed).toBe(false);
    expect(evaluateRule(builtin('allowed-locations', { locations: 'Central India, southindia' }), res(), ctx())?.passed).toBe(true);
  });
  it('required-tags uses its defaults and names what is missing', () => {
    expect(evaluateRule(builtin('required-tags'), res(), ctx())).toEqual({ passed: false, detail: 'missing: cost-center' });
  });
  it('caf-prefix: storage without a dash, VMs with one; unknown types not applicable', () => {
    expect(evaluateRule(builtin('caf-prefix'), res(), ctx())?.passed).toBe(true);
    expect(evaluateRule(builtin('caf-prefix'), res({ name: 'appserver' }), ctx())?.passed).toBe(false);
    expect(evaluateRule(builtin('caf-prefix'), res({ type: 'microsoft.storage/storageaccounts', name: 'stappprod001' }), ctx())?.passed).toBe(true);
    expect(evaluateRule(builtin('caf-prefix'), res({ type: 'microsoft.foo/bars' }), ctx())).toBeNull();
  });
});

describe('custom conditions', () => {
  const custom = (definition: unknown, scope: unknown = null): EvaluableRule => ({ ...builtin(''), source: 'custom', template: null, definition, scope });

  it('all / any across tags, properties and numbers', () => {
    const r = res({ properties: { osProfile: { linuxConfiguration: { disablePasswordAuthentication: true } } }, costMonthly: 120 });
    const all = {
      match: 'all',
      conditions: [
        { field: 'tag', key: 'environment', operator: 'in', value: 'prod, production' },
        { field: 'property', key: 'osProfile.linuxConfiguration.disablePasswordAuthentication', operator: 'is_true' },
        { field: 'costMonthly', operator: 'lt', value: '100' },
      ],
    };
    const v = evaluateRule(custom(all), r, ctx());
    expect(v?.passed).toBe(false);
    expect(v?.detail).toBe('costMonthly = "120"');
    expect(evaluateRule(custom({ ...all, match: 'any' }), r, ctx())?.passed).toBe(true);
  });

  it('an invalid regex never fails resources', () => {
    expect(evaluateRule(custom({ match: 'all', conditions: [{ field: 'name', operator: 'matches', value: '([' }] }), res(), ctx())?.passed).toBe(true);
  });

  it('scope limits which resources are judged', () => {
    const def = { match: 'all', conditions: [{ field: 'tag', key: 'owner', operator: 'exists' }] };
    expect(evaluateRule(custom(def, { types: ['Microsoft.Web/sites'] }), res(), ctx())).toBeNull();
    expect(evaluateRule(custom(def, { tagKey: 'environment', tagValues: ['PROD'] }), res(), ctx())?.passed).toBe(true);
    expect(inScope({ locations: ['southindia'] }, res())).toBe(false);
  });

  it('converts legacy single-condition rules (and keeps their type filter)', () => {
    const legacy: EvaluableRule = { ...builtin(''), source: 'custom', template: null, field: 'tag', operator: 'exists', tagKey: 'cost-center', appliesToType: 'virtualmachines' };
    expect(legacyToDefinition(legacy)?.conditions[0]).toEqual({ field: 'tag', operator: 'exists', key: 'cost-center', value: undefined });
    expect(evaluateRule(legacy, res(), ctx())?.passed).toBe(false);
    expect(evaluateRule(legacy, res({ type: 'microsoft.web/sites' }), ctx())).toBeNull();
    const legacyCost: EvaluableRule = { ...legacy, field: 'cost', operator: 'exists', tagKey: null, appliesToType: null };
    expect(evaluateRule(legacyCost, res(), ctx())?.passed).toBe(true);
  });
});
