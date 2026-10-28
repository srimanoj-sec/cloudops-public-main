import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostQueryError, type ProviderCostRecord } from '@cloudops/provider-sdk';
import { FinopsEngine, type FinopsEngineDeps } from './finops.engine.js';
import { FxRates } from './fx.js';

type Sub = { id: string; externalId: string; name: string; state: string | null; tenant: { id: string; name: string } | null };

const org = { id: 't1', name: 'Org' };
const day = (currency = 'INR'): ProviderCostRecord[] => [
  { resourceExternalId: '/subscriptions/s/resourcegroups/rg/providers/x/y/z', date: '2026-09-24', cost: 10, currency },
];

function engineWith(subs: Sub[], getCost: (subId: string) => Promise<ProviderCostRecord[]>, rates = new Map<string, number>()) {
  const replaceCostWindow = vi.fn(async () => undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => logger };
  const getCostSpy = vi.fn((subId: string) => getCost(subId));
  const deps = {
    registry: { get: () => ({ getCost: getCostSpy }) },
    credentials: { resolve: async () => ({}) },
    repo: {
      listSubscriptions: async () => subs,
      resourceIndex: async () => [],
      replaceCostWindow,
      recomputeRollups: async () => 0,
    },
    events: { emit: async () => undefined },
    logger,
    windowDays: 30,
    fx: new FxRates('INR', rates, async () => {
      throw new Error('offline');
    }),
  } as unknown as FinopsEngineDeps;
  return { engine: new FinopsEngine(deps), getCostSpy, replaceCostWindow };
}

describe('FinopsEngine per-subscription outcomes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function run(engine: FinopsEngine) {
    const promise = engine.run({ providerKey: 'azure' });
    await vi.runAllTimersAsync();
    return promise;
  }

  it('records why each subscription was or was not updated, and never queries a disabled one', async () => {
    const subs: Sub[] = [
      { id: '1', externalId: 'ok', name: 'Updated sub', state: 'Enabled', tenant: org },
      { id: '2', externalId: 'off', name: 'Disabled sub', state: 'Disabled', tenant: org },
      { id: '3', externalId: 'empty', name: 'Empty sub', state: 'Enabled', tenant: org },
      { id: '4', externalId: 'net', name: 'Unreachable sub', state: 'Enabled', tenant: org },
      { id: '5', externalId: 'rbac', name: 'No access sub', state: 'Enabled', tenant: null },
    ];
    const { engine, getCostSpy, replaceCostWindow } = engineWith(subs, async (id) => {
      if (id === 'ok') return day();
      if (id === 'empty') return [];
      if (id === 'net') throw new CostQueryError("Couldn't reach Azure (Network is unreachable).", 'network');
      throw new CostQueryError("The organization's credentials can't read cost for this subscription.", 'no-access');
    });

    const result = await run(engine);

    expect(getCostSpy.mock.calls.map((c) => c[0])).not.toContain('off');
    expect(replaceCostWindow).toHaveBeenCalledTimes(1);
    expect(result.results.map((r) => [r.subscriptionId, r.outcome])).toEqual([
      ['ok', 'updated'],
      ['off', 'disabled'],
      ['empty', 'no-data'],
      ['net', 'network'],
      ['rbac', 'no-access'],
    ]);
    expect(result.results.find((r) => r.subscriptionId === 'net')?.message).toContain('Network is unreachable');
    expect(result.results[0]).toMatchObject({ organization: 'Org', records: 1, message: null });
    // Only transient failures are retried automatically.
    expect(result.retry).toEqual(['net']);
    expect(result.throttled).toEqual([]);
    expect(result.skipped).toBe(4);
  });

  it('treats a bare THROTTLED error from an older provider as throttled', async () => {
    const { engine } = engineWith([{ id: '1', externalId: 's', name: 'S', state: null, tenant: null }], async () => {
      throw Object.assign(new Error('Too Many Requests'), { code: 'THROTTLED' });
    });
    const result = await run(engine);
    expect(result.results[0]?.outcome).toBe('throttled');
    expect(result.throttled).toEqual(['s']);
    expect(result.retry).toEqual(['s']);
  });

  it('keeps a subscription billed in a currency it cannot convert, and says how to fix it', async () => {
    const { engine, replaceCostWindow } = engineWith([{ id: '1', externalId: 's', name: 'S', state: 'Enabled', tenant: null }], async () =>
      day('EUR'),
    );
    const result = await run(engine);
    expect(replaceCostWindow).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ outcome: 'unconverted' });
    expect(result.results[0]?.message).toContain('COST_FX_RATES');
    expect(result.unconverted).toEqual(['S']);
  });
});
