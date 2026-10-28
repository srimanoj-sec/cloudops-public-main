/**
 * Cost anomaly detection — pure, so the rules are unit-tested and explainable.
 *
 * A resource is flagged when its latest daily cost is:
 *  - a **spike**: above its expected range (mean + σ·stddev of the baseline days)
 *    AND at least `threshold`% over the mean AND at least `minDailyDelta` more in
 *    absolute terms (so ₹0.01 → ₹0.02 is never a "100% spike"); or
 *  - **new spend**: it cost nothing on any baseline day and now costs at least
 *    `minDailyDelta` a day (a new deployment, or something switched on).
 * Missing days inside the baseline count as zero — Cost Management omits
 * zero-cost rows — except before a resource's first charge, so a resource born
 * mid-window is compared with its own history only.
 */

export const DAY_MS = 86_400_000;

export interface DetectOptions {
  /** The day being judged (UTC midnight, ms). */
  latest: number;
  /** How many preceding days form the baseline. */
  baselineDays: number;
  /** Minimum % over the baseline mean for a spike. */
  threshold: number;
  /** Minimum absolute daily increase (reporting currency). */
  minDailyDelta: number;
  /** Width of the expected range in standard deviations. */
  sigma?: number;
}

export interface DetectedAnomaly {
  key: string;
  kind: 'spike' | 'new-resource';
  latest: number;
  mean: number;
  stddev: number;
  expectedLow: number;
  expectedHigh: number;
  deltaAbs: number;
  /** % over the baseline mean; null for new spend (no baseline). */
  deltaPct: number | null;
  /** The extra cost per month if the latest day's level persists. */
  monthlyImpact: number;
  baselineDaysUsed: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

export function detectAnomalies(series: Map<string, { date: number; cost: number }[]>, o: DetectOptions): DetectedAnomaly[] {
  const sigma = o.sigma ?? 2;
  const start = o.latest - o.baselineDays * DAY_MS;
  const out: DetectedAnomaly[] = [];

  for (const [key, points] of series) {
    let latestCost = 0;
    const byDay = new Map<number, number>();
    for (const p of points) {
      if (p.date === o.latest) latestCost += p.cost;
      else if (p.date >= start && p.date < o.latest) byDay.set(p.date, (byDay.get(p.date) ?? 0) + p.cost);
    }
    if (latestCost <= 0) continue;

    const charged = [...byDay.entries()].filter(([, c]) => c > 0).map(([d]) => d);
    if (charged.length === 0) {
      if (latestCost >= o.minDailyDelta) {
        out.push({
          key,
          kind: 'new-resource',
          latest: round(latestCost),
          mean: 0,
          stddev: 0,
          expectedLow: 0,
          expectedHigh: 0,
          deltaAbs: round(latestCost),
          deltaPct: null,
          monthlyImpact: round(latestCost * 30),
          // Days checked and found without a charge.
          baselineDaysUsed: o.baselineDays,
        });
      }
      continue;
    }

    // Baseline days: from the first charge in the window (or the window start) to the day before latest.
    const first = Math.min(...charged);
    const values: number[] = [];
    for (let d = first; d < o.latest; d += DAY_MS) values.push(byDay.get(d) ?? 0);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);
    const expectedHigh = mean + sigma * stddev;
    const deltaAbs = latestCost - mean;
    const pct = mean > 0 ? (deltaAbs / mean) * 100 : null;

    if (latestCost <= expectedHigh) continue;
    if (deltaAbs < o.minDailyDelta) continue;
    if (pct !== null && pct < o.threshold) continue;

    out.push({
      key,
      kind: 'spike',
      latest: round(latestCost),
      mean: round(mean),
      stddev: round(stddev),
      expectedLow: round(Math.max(0, mean - sigma * stddev)),
      expectedHigh: round(expectedHigh),
      deltaAbs: round(deltaAbs),
      deltaPct: pct === null ? null : Math.round(pct),
      monthlyImpact: round(deltaAbs * 30),
      baselineDaysUsed: values.length,
    });
  }

  return out.sort((a, b) => b.monthlyImpact - a.monthlyImpact);
}

/**
 * The smallest daily increase worth flagging: 0.5% of the estate's daily spend,
 * and never below one unit of the reporting currency. Scales with the estate —
 * a ₹50/day jump matters on a ₹2,000/day estate, not on a ₹2,00,000/day one.
 */
export function defaultMinDailyDelta(estateDailySpend: number): number {
  return round(Math.max(1, estateDailySpend * 0.005));
}

/** One sentence saying why a resource was flagged, in the reporting currency. */
export function explain(a: DetectedAnomaly, fmt: (n: number) => string, day: string): string {
  if (a.kind === 'new-resource') {
    return `Started costing ${fmt(a.latest)}/day on ${day} after no charges in the previous ${a.baselineDaysUsed} days — about ${fmt(a.monthlyImpact)}/month if it continues.`;
  }
  return `${fmt(a.latest)} on ${day} against an expected ${fmt(a.expectedLow)}–${fmt(a.expectedHigh)} (mean ${fmt(a.mean)} over ${a.baselineDaysUsed} days)${a.deltaPct !== null ? `, +${a.deltaPct}%` : ''} — about ${fmt(a.monthlyImpact)}/month more if it persists.`;
}
