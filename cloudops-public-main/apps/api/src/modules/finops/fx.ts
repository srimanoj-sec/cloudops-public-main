/**
 * Currency conversion for FinOps. Every stored cost is in ONE reporting currency
 * (COST_CURRENCY). Azure bills each billing account in its own currency — a
 * sponsorship or US account can come back in USD while the rest are INR — and
 * summing the two unconverted is simply wrong, so the cost sync converts at
 * ingest and keeps the original amount/currency/rate on the record.
 *
 * Rate sources, in order:
 *  1. COST_FX_RATES (operator-pinned, e.g. `USD=95.5`),
 *  2. the public Azure Retail Prices API: Microsoft prices the same meter in
 *     every currency from its USD price, so INR price ÷ USD price is the rate
 *     Azure itself uses (no key, no third-party service),
 *  3. none → the caller must not store unconverted amounts.
 */

export type FxSource = 'configured' | 'azure-retail-prices';

export interface FxRate {
  /** Units of the reporting currency per 1 unit of `from`. */
  rate: number;
  source: FxSource;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface RetailPriceItem {
  meterId?: string;
  productName?: string;
  skuName?: string;
  type?: string;
  retailPrice?: number;
}

const RETAIL_API = 'https://prices.azure.com/api/retail/prices';
/** A reference meter priced in every supported currency (a common general-purpose VM). */
const REFERENCE_FILTER =
  "serviceName eq 'Virtual Machines' and armRegionName eq 'eastus' and armSkuName eq 'Standard_D2s_v5' and priceType eq 'Consumption'";
const CACHE_MS = 12 * 60 * 60 * 1000;

/** `USD=95.5,EUR=101` → Map (upper-cased codes, positive finite rates only). */
export function parseFxRates(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (raw ?? '').split(',')) {
    const [code, value] = part.split('=').map((s) => s?.trim());
    const rate = Number(value);
    if (code && /^[A-Za-z]{3}$/.test(code) && Number.isFinite(rate) && rate > 0) out.set(code.toUpperCase(), rate);
  }
  return out;
}

/** Median — robust against one odd meter. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export class FxRates {
  private readonly cache = new Map<string, { value: FxRate | null; expires: number }>();

  constructor(
    readonly reporting: string,
    private readonly configured: Map<string, number>,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly onError?: (message: string) => void,
  ) {}

  /** Rate to convert `from` into the reporting currency, or null if unknown. */
  async rate(from: string): Promise<FxRate | null> {
    const code = from.toUpperCase();
    if (code === this.reporting) return { rate: 1, source: 'configured' };
    const pinned = this.configured.get(code);
    if (pinned) return { rate: pinned, source: 'configured' };

    const hit = this.cache.get(code);
    if (hit && hit.expires > Date.now()) return hit.value;
    let value: FxRate | null = null;
    try {
      // Retail prices are all derived from USD: X→R = (USD→R) / (USD→X).
      const [toReporting, toFrom] = await Promise.all([this.usdTo(this.reporting), this.usdTo(code)]);
      if (toReporting && toFrom) value = { rate: toReporting / toFrom, source: 'azure-retail-prices' };
    } catch (err) {
      this.onError?.(`exchange rate ${code}→${this.reporting} unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Cache failures briefly too, so a blocked network isn't hammered per record.
    this.cache.set(code, { value, expires: Date.now() + (value ? CACHE_MS : 5 * 60 * 1000) });
    return value;
  }

  private async usdTo(currency: string): Promise<number | null> {
    if (currency === 'USD') return 1;
    const [usd, other] = await Promise.all([this.prices('USD'), this.prices(currency)]);
    const key = (i: RetailPriceItem) => `${i.meterId}|${i.productName}|${i.skuName}|${i.type}`;
    const usdByKey = new Map(usd.map((i) => [key(i), i.retailPrice ?? 0]));
    const ratios = other
      .map((i) => {
        const base = usdByKey.get(key(i));
        return base && base > 0 && i.retailPrice ? i.retailPrice / base : null;
      })
      .filter((r): r is number => r !== null && Number.isFinite(r) && r > 0);
    return ratios.length ? median(ratios) : null;
  }

  private async prices(currency: string): Promise<RetailPriceItem[]> {
    const url = `${RETAIL_API}?currencyCode=${encodeURIComponent(`'${currency}'`)}&$filter=${encodeURIComponent(REFERENCE_FILTER)}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`retail prices API returned ${res.status}`);
    const body = (await res.json()) as { Items?: RetailPriceItem[] };
    return body.Items ?? [];
  }
}
