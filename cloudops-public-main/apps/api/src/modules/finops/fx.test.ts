import { describe, expect, it } from 'vitest';
import { FxRates, parseFxRates } from './fx.js';

/** A fake Azure Retail Prices API: the same three meters priced per currency. */
function fakePrices(perUsd: Record<string, number>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const code = /currencyCode=(?:%27|')([A-Z]{3})(?:%27|')/.exec(url)?.[1] ?? '';
    const k = perUsd[code];
    if (!k) return { ok: false, status: 400, json: async () => ({}) };
    const base = [0.096, 0.188, 0.041];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        Items: base.map((usd, i) => ({ meterId: `m${i}`, productName: 'p', skuName: 's', type: 'Consumption', retailPrice: usd * k })),
      }),
    };
  };
  return { fetchImpl, calls };
}

describe('parseFxRates', () => {
  it('reads pinned rates and ignores junk', () => {
    const m = parseFxRates('usd=95.5, EUR=101 ,bad,XYZ=-1,GBP=abc');
    expect([...m.entries()]).toEqual([
      ['USD', 95.5],
      ['EUR', 101],
    ]);
    expect(parseFxRates(undefined).size).toBe(0);
  });
});

describe('FxRates', () => {
  it('is 1 for the reporting currency and prefers pinned rates', async () => {
    const { fetchImpl, calls } = fakePrices({ USD: 1, INR: 95.54 });
    const fx = new FxRates('INR', parseFxRates('USD=90'), fetchImpl);
    expect(await fx.rate('INR')).toEqual({ rate: 1, source: 'configured' });
    expect(await fx.rate('usd')).toEqual({ rate: 90, source: 'configured' });
    expect(calls).toHaveLength(0);
  });

  it('derives USD→INR from Azure retail prices (INR price ÷ USD price)', async () => {
    const { fetchImpl } = fakePrices({ USD: 1, INR: 95.54 });
    const fx = new FxRates('INR', new Map(), fetchImpl);
    const r = await fx.rate('USD');
    expect(r?.source).toBe('azure-retail-prices');
    expect(r?.rate).toBeCloseTo(95.54, 6);
  });

  it('crosses through USD for other currencies (EUR→INR)', async () => {
    const { fetchImpl } = fakePrices({ USD: 1, INR: 95.54, EUR: 0.9 });
    const r = await new FxRates('INR', new Map(), fetchImpl).rate('EUR');
    expect(r?.rate).toBeCloseTo(95.54 / 0.9, 6);
  });

  it('returns null (never a guess) when the rate is unknown, and caches it', async () => {
    const errors: string[] = [];
    const { fetchImpl, calls } = fakePrices({ USD: 1, INR: 95.54 }); // no XYZ prices
    const fx = new FxRates('INR', new Map(), fetchImpl, (m) => errors.push(m));
    expect(await fx.rate('XYZ')).toBeNull();
    const before = calls.length;
    expect(await fx.rate('XYZ')).toBeNull();
    expect(calls.length).toBe(before); // cached, not refetched
  });
});
