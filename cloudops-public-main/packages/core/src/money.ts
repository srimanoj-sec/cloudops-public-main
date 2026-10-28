/**
 * Money formatting shared by the API (text in DTOs) and the web app, so a cost
 * reads the same everywhere. Each currency uses its home locale: INR groups in
 * lakhs/crores (₹2,10,120 · compact ₹2.1L / ₹1.2Cr), USD as $210,120 / $210K.
 */

const HOME_LOCALE: Record<string, string> = { INR: 'en-IN', USD: 'en-US', EUR: 'de-DE', GBP: 'en-GB', JPY: 'ja-JP' };

const cache = new Map<string, Intl.NumberFormat>();
function formatter(currency: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${currency}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(HOME_LOCALE[currency] ?? 'en-US', { style: 'currency', currency, ...options });
    cache.set(key, f);
  }
  return f;
}

export interface MoneyFormatOptions {
  /** Short form for tight spaces: ₹2.1L, ₹85K, $1.2M. */
  compact?: boolean;
  /** Fraction digits for the full form (default: 0 at or above 1,000, else 2). */
  decimals?: number;
}

export function formatMoney(
  amount: number | null | undefined,
  currency: string | null | undefined,
  options: MoneyFormatOptions = {},
): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const code = (currency ?? '').toUpperCase();
  const abs = Math.abs(amount);
  try {
    if (!/^[A-Z]{3}$/.test(code)) throw new Error('no currency');
    if (options.compact) {
      if (abs < 1_000) return formatter(code, { maximumFractionDigits: abs < 100 ? 2 : 0, minimumFractionDigits: 0 }).format(amount);
      return formatter(code, { notation: 'compact', maximumFractionDigits: 1 }).format(amount);
    }
    const digits = options.decimals ?? (abs >= 1_000 ? 0 : 2);
    return formatter(code, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(amount);
  } catch {
    const n = abs >= 1_000 ? Math.round(amount).toLocaleString('en-US') : amount.toFixed(2);
    return code ? `${n} ${code}` : n;
  }
}
