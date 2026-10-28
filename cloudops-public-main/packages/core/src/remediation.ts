import { z } from 'zod';
import type { RuleParamSpec } from './standards.js';

/**
 * Remediation: a change from the action catalog, planned against specific
 * resources, previewed (dry run), approved when risky, executed in the
 * background, verified by reading each resource back, and audited throughout.
 *
 *   plan → request → (approve) → execute → verify → record
 */

export const REMEDIATION_RISKS = ['low', 'medium', 'high'] as const;
export type RemediationRisk = (typeof REMEDIATION_RISKS)[number];

export const REMEDIATION_STATUSES = [
  'pending_approval',
  'approved',
  'rejected',
  'queued',
  'running',
  'completed',
  'partial',
  'failed',
  'cancelled',
] as const;
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];

export const REMEDIATION_STATUS_LABELS: Record<RemediationStatus, string> = {
  pending_approval: 'Waiting for approval',
  approved: 'Approved — ready to run',
  rejected: 'Rejected',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  partial: 'Partly failed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export type RemediationTargetStatus = 'pending' | 'skipped' | 'running' | 'succeeded' | 'verified' | 'verify_failed' | 'failed';

/** An action in the catalog. */
export interface RemediationActionDto {
  key: string;
  title: string;
  /** What it does and why. */
  description: string;
  /** The concrete change, e.g. "Sets HTTPS Only = On". */
  change: string;
  risk: RemediationRisk;
  /** Why it has that risk (what could break). */
  riskReason: string;
  /** Library rule templates this action fixes. */
  fixesRules: string[];
  appliesTo: string;
  /** Lower-cased resource types it can act on; null = any. */
  types: string[] | null;
  params: RuleParamSpec[];
  /** Can it be undone, and how. */
  reversible: boolean;
  rollback: string;
  /** Impact while it runs ("none", "the VM restarts"…). */
  disruption: string;
  /** Medium and high risk changes need a second person's approval. */
  requiresApproval: boolean;
  /** False when the provider can't do it here (no capability, or write-back is off). */
  available: boolean;
  unavailableReason: string | null;
}

export const remediationTargetingSchema = z
  .object({
    actionKey: z.string().min(1).max(100),
    /** Resources to act on (db ids). */
    resourceIds: z.array(z.string().min(1).max(64)).max(500).optional(),
    /** Or: every resource currently failing this rule (non-exempt). */
    ruleId: z.string().max(64).optional(),
    /** Or: every resource matching an inventory filter (the inventory's query params). */
    filter: z.record(z.string().max(2000)).optional(),
    params: z.record(z.unknown()).optional(),
  })
  .refine((v) => (v.resourceIds?.length ?? 0) > 0 || Boolean(v.ruleId) || Boolean(v.filter), 'Choose resources, a rule or a filter');
export type RemediationTargeting = z.infer<typeof remediationTargetingSchema>;

export const createRemediationSchema = z.object({
  actionKey: z.string().min(1).max(100),
  resourceIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  ruleId: z.string().max(64).optional(),
  filter: z.record(z.string().max(2000)).optional(),
  params: z.record(z.unknown()).optional(),
  /** Why — shown to the approver and kept in the record. */
  note: z.string().trim().max(1000).optional(),
  workItemId: z.string().max(64).optional(),
  source: z.object({ type: z.string().max(40), id: z.string().max(300), label: z.string().max(300).optional() }).optional(),
  /** Low-risk actions only: queue immediately instead of waiting for "Run". */
  executeNow: z.boolean().optional(),
});
export type CreateRemediationRequest = z.infer<typeof createRemediationSchema>;

export const decideRemediationSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(1000).optional(),
});
export type DecideRemediationRequest = z.infer<typeof decideRemediationSchema>;

export const remediationQuerySchema = z.object({
  status: z.enum(REMEDIATION_STATUSES).optional(),
  sourceType: z.string().max(40).optional(),
  sourceId: z.string().max(300).optional(),
  resourceId: z.string().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type RemediationQuery = z.infer<typeof remediationQuerySchema>;

/** One resource in a plan (dry run). */
export interface RemediationPlanTargetDto {
  resourceId: string;
  name: string;
  type: string;
  resourceGroup: string | null;
  subscription: string | null;
  /** Current value as last synced, and the value it will be set to. */
  current: string;
  desired: string;
  /** The exact provider call. */
  command: string | null;
  /** Why it will be skipped (already compliant, deleted, wrong type…). */
  skip: string | null;
}

export interface RemediationPlanDto {
  action: RemediationActionDto;
  targets: RemediationPlanTargetDto[];
  willChange: number;
  skipped: number;
  requiresApproval: boolean;
  warnings: string[];
}

export interface RemediationRunDto {
  id: string;
  actionKey: string;
  title: string;
  risk: RemediationRisk;
  status: RemediationStatus;
  params: Record<string, unknown> | null;
  source: { type: string; id: string; label?: string } | null;
  workItemId: string | null;
  requestedBy: string | null;
  requestedById: string | null;
  approvedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  executedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: { total: number; succeeded: number; failed: number; skipped: number; verified: number } | null;
  error: string | null;
  targetCount: number;
  createdAt: string;
}

export interface RemediationTargetDto {
  id: string;
  resourceId: string;
  resourceName: string;
  externalId: string;
  status: RemediationTargetStatus;
  before: unknown;
  after: unknown;
  command: string | null;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RemediationLogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface RemediationRunDetailDto extends RemediationRunDto {
  targets: RemediationTargetDto[];
  log: RemediationLogEntry[];
  action: RemediationActionDto | null;
  /** What the caller may do with it now. */
  allowed: { approve: boolean; reject: boolean; execute: boolean; cancel: boolean; reason: string | null };
}
