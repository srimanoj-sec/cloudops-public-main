import { describe, expect, it } from 'vitest';
import { DAY_MS, defaultMinDailyDelta, detectAnomalies, explain } from './anomaly.js';

const LATEST = Date.UTC(2026, 8, 27);
/** Daily costs for the 7 baseline days (oldest first) then the latest day. */
function series(key: string, baseline: (number | null)[], latest: number) {
  const pts = baseline
    .map((cost, i) => (cost == null ? null : { date: LATEST - (baseline.length - i) * DAY_MS, cost }))
    .filter((p): p is { date: number; cost: number } => p !== null);
  pts.push({ date: LATEST, cost: latest });
  return new Map([[key, pts]]);
}
const opts = { latest: LATEST, baselineDays: 7, threshold: 10, minDailyDelta: 5 };

describe('detectAnomalies', () => {
  it('flags a spike above the expected range with its monthly impact', () => {
    const [a] = detectAnomalies(series('vm', [100, 102, 98, 101, 99, 100, 100], 180), opts);
    expect(a?.kind).toBe('spike');
    expect(a?.mean).toBe(100);
    expect(a?.deltaPct).toBe(80);
    expect(a?.monthlyImpact).toBe(2400);
    expect(a!.expectedHigh).toBeLessThan(180);
  });

  it('ignores tiny absolute changes however large the percentage (₹0.01 → ₹0.02)', () => {
    expect(detectAnomalies(series('backup', [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01], 0.02), opts)).toEqual([]);
  });

  it('ignores normal variation inside mean ± 2σ', () => {
    expect(detectAnomalies(series('noisy', [50, 90, 60, 100, 55, 95, 70], 105), opts)).toEqual([]);
  });

  it('treats missing baseline days as zero after the first charge', () => {
    // Charged every other day: mean is ~half the charge, so a normal charge day is no spike.
    const [a] = detectAnomalies(series('batch', [40, null, 40, null, 40, null, 40], 40), { ...opts, minDailyDelta: 1 });
    expect(a).toBeUndefined();
  });

  it('flags spend that just appeared as new, with no baseline percentage', () => {
    const [a] = detectAnomalies(series('new', [null, null, null, null, null, null, null], 60), opts);
    expect(a?.kind).toBe('new-resource');
    expect(a?.deltaPct).toBeNull();
    expect(a?.monthlyImpact).toBe(1800);
  });

  it('does not flag new spend below the floor', () => {
    expect(detectAnomalies(series('new', [null, null, null, null, null, null, null], 2), opts)).toEqual([]);
  });

  it('compares a resource born mid-window with its own days only', () => {
    // First charge 3 days ago at a steady 30/day → 31 today is normal.
    expect(detectAnomalies(series('young', [null, null, null, null, 30, 30, 30], 31), opts)).toEqual([]);
  });

  it('sorts by monthly impact', () => {
    const m = new Map([...series('small', [10, 10, 10, 10, 10, 10, 10], 30), ...series('big', [100, 100, 100, 100, 100, 100, 100], 300)]);
    expect(detectAnomalies(m, opts).map((a) => a.key)).toEqual(['big', 'small']);
  });
});

describe('defaultMinDailyDelta', () => {
  it('is 0.5% of daily spend, never below 1', () => {
    expect(defaultMinDailyDelta(7000)).toBe(35);
    expect(defaultMinDailyDelta(50)).toBe(1);
  });
});

describe('explain', () => {
  it('says what was expected and what it costs', () => {
    const [a] = detectAnomalies(series('vm', [100, 100, 100, 100, 100, 100, 100], 200), opts);
    const text = explain(a!, (n) => `₹${n}`, '2026-09-27');
    expect(text).toContain('expected ₹100–₹100');
    expect(text).toContain('+100%');
    expect(text).toContain('₹3000/month');
  });
});
