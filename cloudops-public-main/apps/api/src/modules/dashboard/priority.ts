/**
 * Priority scoring — transparent by construction. A score is a base for the
 * severity plus named factors; the factors are returned with the score, so the
 * UI can say exactly why one item ranks above another. No hidden weights.
 *
 *   severity   critical 55 · high 40 · medium 25 · low 10
 *   blast      +5 per doubling of affected resources (2→5, 4→10, 8+→15)
 *   production +15 when any affected resource is tagged production
 *   cost       +1 per 0.5% of the estate's monthly spend at stake (max 20)
 *   lateness   +1 per day overdue (max 10)
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface PriorityInput {
  severity: Severity;
  affected?: number | null;
  production?: number;
  costImpact?: number | null;
  /** The estate's monthly spend — cost at stake is judged relative to it. */
  estateMonthly?: number;
  overdueDays?: number;
}

export interface Scored {
  score: number;
  factors: { label: string; points: number }[];
}

export const SEVERITY_BASE: Record<Severity, number> = { critical: 55, high: 40, medium: 25, low: 10 };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function scorePriority(i: PriorityInput, money: (n: number) => string): Scored {
  const factors: { label: string; points: number }[] = [{ label: `${i.severity} severity`, points: SEVERITY_BASE[i.severity] }];

  const affected = i.affected ?? 0;
  if (affected > 1) {
    factors.push({ label: `${plural(affected, 'resource')} affected`, points: Math.min(15, Math.round(5 * Math.log2(affected))) });
  }
  if ((i.production ?? 0) > 0) {
    factors.push({ label: `${plural(i.production!, 'production resource')}`, points: 15 });
  }
  const cost = i.costImpact ?? 0;
  if (cost > 0) {
    if (i.estateMonthly && i.estateMonthly > 0) {
      const share = cost / i.estateMonthly;
      factors.push({
        label: `${money(cost)}/mo at stake (${(share * 100).toFixed(share < 0.01 ? 2 : 1)}% of spend)`,
        points: Math.min(20, Math.max(1, Math.round(share * 200))),
      });
    } else {
      factors.push({ label: `${money(cost)}/mo at stake`, points: 5 });
    }
  }
  if ((i.overdueDays ?? 0) > 0) {
    factors.push({ label: `${plural(i.overdueDays!, 'day')} overdue`, points: Math.min(10, i.overdueDays!) });
  }

  const total = factors.reduce((n, f) => n + f.points, 0);
  return { score: Math.min(100, total), factors };
}
