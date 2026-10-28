export interface DashboardKpis {
  organizations: number;
  subscriptions: number;
  resourceGroups: number;
  resources: number;
  distinctTypes: number;
  distinctLocations: number;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  /** True when Postgres has inventory but Azure connectivity is not required to read it. */
  offlineReady: boolean;
  /** When the most recent sync that COMPLETED finished (drives staleness). */
  lastCompletedSyncAt?: string | null;
}

export interface CountBucket {
  label: string;
  count: number;
}

export interface DashboardSummary {
  kpis: DashboardKpis;
  resourcesByType: CountBucket[];
  resourcesByLocation: CountBucket[];
  resourcesBySubscription: CountBucket[];
  resourcesByOrganization: CountBucket[];
}

// ── Operations Command Center (cross-module overview) ─────────────

export interface HealthComponentDto {
  key: 'compliance' | 'ownership' | 'cost-visibility';
  label: string;
  score: number;
  /** What pulls it down, in words. */
  detail: string;
  link: string;
}

export interface HealthBlock {
  /** 0..100 composite of the signals below (the ones with data). */
  score: number;
  complianceScore: number | null;
  /** % of resources that have a resolved owner. */
  ownershipCoverage: number;
  /** % of resources that have cost data (needs a FinOps sync). */
  costCoverage: number;
  /** The signals the score is the mean of — "what exactly is unhealthy". */
  components: HealthComponentDto[];
}

// ── Priority queue ─────────────────────────────────────────────────

export const PRIORITY_KINDS = [
  'compliance',
  'cost-anomaly',
  'budget',
  'orphaned-spend',
  'sync',
  'provider',
  'work',
  'ownership',
  'exemption',
  'approval',
  'drift',
] as const;
export type PriorityKind = (typeof PRIORITY_KINDS)[number];

/**
 * One thing that needs attention, ranked by a transparent score: a base for its
 * severity plus named factors (blast radius, production, cost at stake, age).
 * `factors` always sum to `score` (capped at 100) so the ranking can be explained.
 */
export interface PriorityItemDto {
  id: string;
  kind: PriorityKind;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  score: number;
  factors: { label: string; points: number }[];
  /** Resources affected, when that applies. */
  affected: number | null;
  /** Monthly cost at stake, when known. */
  costImpact: number | null;
  /** Where to investigate. */
  link: string;
  /** What created it, for "create work item" with the origin pre-filled. */
  source: { type: string; id: string; label: string } | null;
  /** A remediation action exists for it (compliance). */
  remediable: boolean;
}

export interface CostInsightsBlock {
  /** Month to date and forecast (null when no cost data). */
  monthToDate: number | null;
  forecast: number | null;
  lastMonthToDate: number | null;
  budgetsAtRisk: number;
  budgetsOver: number;
  /** Monthly cost of resources failing cost-optimization rules. */
  savingsOpportunity: number;
  savingsCount: number;
  /** Monthly cost billed to deleted resources. */
  orphanedSpend: number;
}

export interface TopSpenderDto {
  id: string;
  name: string;
  type: string;
  monthly: number;
}

export interface CostBlock {
  currency: string;
  /** Trailing-30-day cost of ACTIVE inventory resources (sum of their rollups). */
  monthlyProjected: number;
  /**
   * Trailing-30-day cost that matches no inventory resource — e.g. resources in
   * scopes that aren't synced, or deleted resource groups that still bill.
   * FinOps totals include it; monthlyProjected + this ≈ the FinOps 30-day total.
   */
  unattributedMonthly: number;
  dailyAvg: number;
  topSpenders: TopSpenderDto[];
  hasData: boolean;
}

export interface FailingRuleDto {
  id: string; // StandardRule id (drilldown)
  name: string;
  standardName: string;
  severity: string;
  failed: number;
}

export interface ComplianceBlock {
  evaluatedAt: string | null;
  score: number;
  passed: number;
  failed: number;
  bySeverity: { severity: string; failed: number }[];
  topFailing: FailingRuleDto[];
  /** Compliance is scored estate-wide (not yet per-org). */
  estateWide: boolean;
}

export interface WorkBlock {
  open: number;
  overdue: number;
  inProgress: number;
  blocked: number;
  done: number;
}

/** An actionable "needs attention" card. */
export interface InsightDto {
  key: string;
  label: string;
  count: number;
  /** Optional secondary figure, e.g. monthly spend at risk. */
  detail: string | null;
  to: string;
  tone: 'red' | 'amber' | 'slate' | 'green';
}

export interface DriftEventDto {
  id: string;
  resourceId: string | null;
  resourceName: string | null;
  field: string;
  detectedAt: string;
}

export interface SyncBlock {
  /** When the last successfully completed sync finished. */
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  /** True when the last sync is older than 24h (or there has never been one). */
  stale: boolean;
}

export interface UrgentWorkDto {
  id: string;
  title: string;
  priority: number;
  state: string;
  assignee: string | null;
  dueDate: string | null;
  overdue: boolean;
  /** First linked scope, for context. */
  scope: { type: string; id: string; name: string | null } | null;
}

export interface DashboardOverview {
  kpis: DashboardKpis;
  health: HealthBlock;
  /** Ranked "what to do first", with the reasons for each rank. */
  priorities: PriorityItemDto[];
  costInsights: CostInsightsBlock;
  urgentWork: UrgentWorkDto[];
  cost: CostBlock;
  compliance: ComplianceBlock;
  work: WorkBlock;
  insights: InsightDto[];
  drift: DriftEventDto[];
  resourcesByType: CountBucket[];
  resourcesByOrganization: CountBucket[];
  sync: SyncBlock;
}
