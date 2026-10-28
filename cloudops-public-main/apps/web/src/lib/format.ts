import { formatMoney } from '@cloudops/core';

/** Compact currency (₹2.1L, ₹85K, ₹12.40) — shared across cost surfaces. */
export function money(amount: number | null | undefined, currency?: string | null): string {
  return formatMoney(amount, currency, { compact: true });
}

/** Full currency amount in the currency's own grouping (₹2,10,120). */
export function moneyFull(
  amount: number | null | undefined,
  currency?: string | null,
  decimals?: number,
): string {
  return formatMoney(amount, currency, { decimals });
}

/** Daily-cost label, e.g. "₹12.40/day" or "—" when there's no cost data. */
export function dailyCost(amount: number | null | undefined, currency?: string | null): string {
  if (amount == null) return '—';
  return `${money(amount, currency)}/day`;
}

/** Resource type without the provider namespace, case-insensitively: "microsoft.web/sites" → "web/sites". */
export function shortType(type: string): string {
  return type.replace(/^microsoft\./i, '');
}

/** "3m ago", "2h ago", "4d ago", then a date. */
export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** A duration in words an operator scans: "850 ms", "42 s", "3m 10s", "2h 5m". */
export function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
