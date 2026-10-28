import { z } from 'zod';

/** Request to run (enqueue) a cost sync. */
export const finopsSyncRequestSchema = z.object({
  providerKey: z.string().default('azure'),
  /** Window in days to pull; defaults to the server's configured window. */
  days: z.coerce.number().int().positive().max(365).optional(),
});
export type FinopsSyncRequest = z.infer<typeof finopsSyncRequestSchema>;

// ── Cost explorer query ──────────────────────────────────────────

export const FINOPS_PRESETS = ['1d', '7d', '30d', '90d', 'custom'] as const;
export type FinopsPreset = (typeof FINOPS_PRESETS)[number];

export const FINOPS_GRANULARITIES = ['day', 'week', 'month'] as const;
export type FinopsGranularity = (typeof FINOPS_GRANULARITIES)[number];

export const FINOPS_GROUP_BY = ['organization', 'subscription', 'resourceGroup', 'resource', 'service', 'category', 'owner', 'tag'] as const;
export type FinopsGroupBy = (typeof FINOPS_GROUP_BY)[number];

const boolFromQuery = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => v === true || v === 'true' || v === '1');

/** Cost explorer query params (GET query string). Scope ids are DB ids. */
export const finopsQuerySchema = z.object({
  preset: z.enum(FINOPS_PRESETS).default('30d'),
  /** Custom range (YYYY-MM-DD, inclusive) — used when preset = 'custom'. */
  from: z.string().optional(),
  to: z.string().optional(),
  granularity: z.enum(FINOPS_GRANULARITIES).optional(),
  groupBy: z.enum(FINOPS_GROUP_BY).default('subscription'),
  tenantId: z.string().optional(),
  subscriptionId: z.string().optional(),
  resourceGroupId: z.string().optional(),
  resourceId: z.string().optional(),
  /** Compute a comparison period. Defaults to the immediately-preceding window. */
  compare: boolFromQuery,
  /** Custom comparison baseline (YYYY-MM-DD, inclusive). Overrides the auto window. */
  compareFrom: z.string().optional(),
  compareTo: z.string().optional(),
  /** Tag key to break cost down by (groupBy = tag) — showback/chargeback. */
  tagKey: z.string().max(200).optional(),
});
export type FinopsQuery = z.infer<typeof finopsQuerySchema>;

// ── Overview: this month, leaks, savings, budgets ────────────────

export const finopsScopeQuerySchema = z.object({
  tenantId: z.string().optional(),
  subscriptionId: z.string().optional(),
});
export type FinopsScopeQuery = z.infer<typeof finopsScopeQuerySchema>;

export type UnattributedReason = 'deleted' | 'not-in-inventory' | 'subscription-level';

export interface UnattributedItemDto {
  /** Lower-cased Azure resource id the cost was billed to. */
  resourceExternalId: string;
  name: string;
  type: string | null;
  resourceGroup: string | null;
  subscription: string | null;
  reason: UnattributedReason;
  /** Inventory row, when the resource is known but deleted. */
  resourceId: string | null;
  cost30d: number;
  lastCostDate: string;
}

export interface SavingsItemDto {
  resourceId: string;
  name: string;
  type: string;
  finding: string;
  detail: string | null;
  costMonthly: number;
}

export const BUDGET_SCOPES = ['all', 'organization', 'subscription', 'resourceGroup'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const budgetInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopeType: z.enum(BUDGET_SCOPES).default('all'),
  scopeId: z.string().max(100).optional(),
  amount: z.coerce.number().positive().max(1e12),
  alertPercent: z.coerce.number().int().min(1).max(100).default(80),
});
export type BudgetInput = z.infer<typeof budgetInputSchema>;

export interface BudgetStatusDto {
  id: string;
  name: string;
  scopeType: BudgetScope;
  scopeId: string | null;
  scopeName: string;
  amount: number;
  alertPercent: number;
  /** Month-to-date spend in the scope. */
  spent: number;
  forecast: number;
  percentUsed: number;
  forecastPercent: number;
  /** over = already exceeded; at-risk = forecast crosses the alert threshold. */
  status: 'ok' | 'at-risk' | 'over';
}

export interface FinopsOverviewDto {
  currency: string;
  /** Newest day with cost data (Cost Management lags ~1-2 days). */
  latestDate: string | null;
  month: {
    label: string;
    toDate: number;
    /** Same number of days into last month — an apples-to-apples comparison. */
    lastMonthToDate: number;
    lastMonthTotal: number;
    /** Average daily cost over the last 7 days of data. */
    runRate: number;
    forecast: number;
    daysElapsed: number;
    daysInMonth: number;
  };
  unattributed: {
    total: number;
    byReason: { reason: UnattributedReason; cost: number; count: number }[];
    items: UnattributedItemDto[];
  };
  savings: { total: number; count: number; items: SavingsItemDto[] };
  budgets: BudgetStatusDto[];
}

export interface FinopsSeriesPoint {
  bucket: string; // start date of the bucket (YYYY-MM-DD)
  cost: number;
  previousCost?: number;
  previousBucket?: string; // the aligned previous-period date (YYYY-MM-DD)
}

export interface FinopsBreakdownRow {
  key: string; // stable grouping key (external id / tenant id)
  label: string;
  scopeType: FinopsGroupBy;
  scopeId: string | null; // DB id for drill / navigation (null if not in inventory)
  cost: number;
  previousCost?: number;
  deltaPct?: number | null; // null when previous is 0 (no baseline)
}

export interface FinopsRange {
  from: string; // ISO
  to: string; // ISO (exclusive)
  days: number;
}

export interface FinopsQueryResult {
  currency: string;
  groupBy: FinopsGroupBy;
  granularity: FinopsGranularity;
  range: FinopsRange;
  previousRange: FinopsRange | null;
  /** True only when stored history fully covers the previous period. */
  previousComplete: boolean;
  /** Earliest date we hold cost data for (ISO), or null if none. */
  earliestData: string | null;
  total: number;
  previousTotal: number | null;
  deltaAbs: number | null;
  deltaPct: number | null; // negative = savings
  hasData: boolean;
  series: FinopsSeriesPoint[];
  breakdown: FinopsBreakdownRow[];
}

// ── Cost sync runs (job status) ──────────────────────────────────

export type CostSyncStatus = 'queued' | 'running' | 'completed' | 'failed';

/**
 * What a cost sync did with one subscription. Anything but `updated` leaves the
 * subscription's existing cost data untouched.
 * - `no-data`: Azure returned no cost for the window.
 * - `disabled`: disabled or deleted in Azure, so not queried.
 * - `throttled` / `network`: transient; retried automatically.
 * - `no-access`: the organization's credentials can't read its cost.
 * - `unsupported`: Cost Management doesn't cover the subscription's offer.
 * - `unconverted`: billed in a currency with no exchange rate available.
 */
export const COST_SYNC_OUTCOMES = [
  'updated',
  'no-data',
  'disabled',
  'throttled',
  'network',
  'no-access',
  'unsupported',
  'unconverted',
  'error',
] as const;
export type CostSyncOutcome = (typeof COST_SYNC_OUTCOMES)[number];

/** Outcomes that need nobody's attention. */
export const HEALTHY_COST_SYNC_OUTCOMES: readonly CostSyncOutcome[] = ['updated', 'no-data', 'disabled'];

/** One subscription's result within a cost sync. */
export interface CostSyncSubscriptionResultDto {
  /** Provider (Azure) subscription id. */
  subscriptionId: string;
  name: string;
  organization: string | null;
  outcome: CostSyncOutcome;
  /** Cost records stored (0 unless `updated`). */
  records: number;
  /** Why it wasn't updated, in words an operator can act on. */
  message: string | null;
}

/**
 * Status of a background cost-sync job, projected from the BullMQ queue (no DB
 * row). Lets the FinOps page show queued → running → completed like inventory sync.
 */
export interface CostSyncRunDto {
  id: string;
  status: CostSyncStatus;
  /** The window (days) requested for this sync. */
  days: number | null;
  /** Result counts (present once completed). */
  records: number | null;
  subscriptions: number | null;
  /** Subscriptions not updated, for any reason (see `results`). */
  skipped: number | null;
  /** Per-subscription outcome. Null for runs recorded before outcomes were tracked. */
  results: CostSyncSubscriptionResultDto[] | null;
  /** 0 for a normal run; n for the nth automatic retry of throttled/unreachable subscriptions. */
  retryAttempt: number;
  error: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Cost data coverage for one subscription: how current its cost is, and why if it isn't. */
export interface CostCoverageDto {
  id: string;
  subscriptionId: string;
  name: string;
  organizationId: string | null;
  organization: string | null;
  /** Azure state (Enabled, Disabled, …). */
  state: string | null;
  /** The most recent day with stored cost (YYYY-MM-DD), or null if none ever. */
  lastCostDate: string | null;
  /** The subscription's result in the most recent sync that included it. */
  last: (CostSyncSubscriptionResultDto & { at: string | null }) | null;
}

// ── Cost anomaly / spike detection ───────────────────────────────

/** Query for the cost anomaly monitor. */
export const costAnomaliesQuerySchema = z.object({
  /** Organization = Tenant db id (scopes to that org's subscriptions). */
  tenantId: z.string().optional(),
  /** Minimum % over the baseline mean to flag a spike (default 10). */
  threshold: z.coerce.number().min(1).max(1000).optional(),
  /**
   * Minimum absolute daily increase (reporting currency) to flag anything.
   * Default: 0.5% of the scope's daily spend, never below 1 — so tiny amounts
   * never show up as big percentages.
   */
  minDelta: z.coerce.number().min(0).max(1e9).optional(),
});
export type CostAnomaliesQuery = z.infer<typeof costAnomaliesQuerySchema>;

/**
 * - `spike`: a resource's latest day is above its expected range;
 * - `new-resource`: a resource started costing (no charge in the baseline days);
 * - `new-region`: a region with no spend in the baseline days now has some.
 */
export const COST_ANOMALY_KINDS = ['spike', 'new-resource', 'new-region'] as const;
export type CostAnomalyKind = (typeof COST_ANOMALY_KINDS)[number];

export interface CostAnomalyDto {
  kind: CostAnomalyKind;
  resourceId: string | null; // DB id for navigation (null if not in inventory / a region)
  externalId: string; // lower-cased resource id, or `region:<name>`
  name: string;
  type: string;
  resourceGroup: string | null;
  subscription: string | null;
  location: string | null;
  latest: number; // most recent day's cost
  baseline: number; // mean daily cost over the baseline days (0 for new spend)
  /** The range the latest day was expected to fall in (mean ± 2σ). */
  expectedLow: number;
  expectedHigh: number;
  deltaAbs: number; // latest − baseline
  deltaPct: number | null; // % over the baseline mean; null when there was no baseline
  /** Extra cost per month if the latest day's level persists. */
  monthlyImpact: number;
  /** 10% band a spike falls into: 10,20,…,90,100 (100 = "100%+"); 0 for new spend. */
  band: number;
  latestDate: string; // YYYY-MM-DD of the latest day
  /** Why it was flagged, in words. */
  reason: string;
}

/** Count of flagged spikes in one 10% hike band. */
export interface CostAnomalyBand {
  band: number; // lower bound of the band; 100 = "100%+"
  count: number;
}

export interface CostAnomaliesDto {
  currency: string;
  /** The threshold (%) applied. */
  threshold: number;
  /** The absolute daily floor applied (reporting currency). */
  minDailyDelta: number;
  /** How many prior days the baseline averages over. */
  baselineDays: number;
  /** The latest day cost data covers (ISO date), or null when there is none. */
  latestDate: string | null;
  /** Distribution of flagged spikes across 10% bands (ascending). */
  bands: CostAnomalyBand[];
  byKind: { kind: CostAnomalyKind; count: number }[];
  /** Total flagged. */
  flagged: number;
  /** Sum of the flagged items' monthly impact. */
  totalMonthlyImpact: number;
  /** The flagged items, largest monthly impact first (capped). */
  anomalies: CostAnomalyDto[];
}

// ── Per-resource trend (resource detail Cost tab) ────────────────

export interface CostTrendPoint {
  date: string; // YYYY-MM-DD
  cost: number;
}

export interface ResourceCostTrendDto {
  currency: string;
  points: CostTrendPoint[];
  totalWindow: number;
  costDaily: number | null;
  costMonthly: number | null;
}
