import { z } from 'zod';
import { WORK_ITEM_STATES, type WorkItemState } from './enums.js';

/**
 * Work-management contracts. Work items are the unit of tracked cloud activity;
 * a `WorkItemLink` ties one to any scope (organization / subscription / resource
 * group / resource) so tasks can be created and viewed from any entity.
 */

/** Alias kept for readability at DTO call sites. */
export type WorkItemStateDto = WorkItemState;

/** Suggested work-item categories (free-form on the wire, but these seed the UI). */
export const WORK_ITEM_TYPES = [
  'task',
  'cost',
  'security',
  'incident',
  'change',
  'review',
  'maintenance',
] as const;

export const WORK_SCOPE_TYPES = ['organization', 'subscription', 'resourceGroup', 'resource'] as const;
export type WorkScopeType = (typeof WORK_SCOPE_TYPES)[number];

export const WORK_RECURRENCES = ['weekly', 'monthly', 'quarterly'] as const;
export type WorkRecurrence = (typeof WORK_RECURRENCES)[number];

/**
 * What created a work item (compliance finding, cost anomaly, drift, failed
 * sync, remediation, automation…). Free-form on the wire; these are the kinds
 * the platform itself creates and knows how to link back to.
 */
export const WORK_SOURCE_TYPES = [
  'rule',
  'costAnomaly',
  'budget',
  'orphanedSpend',
  'drift',
  'syncRun',
  'remediation',
  'provider',
  'ownership',
  'automation',
] as const;

export interface WorkSourceDto {
  type: string;
  id: string;
  label: string | null;
}

export interface WorkItemLinkDto {
  id: string;
  scopeType: string;
  scopeId: string;
  /** Resolved display name for the linked entity (null if it no longer exists). */
  scopeName: string | null;
}

export interface WorkLabelDto {
  id: string;
  name: string;
  color: string;
}

export interface WorkItemDto {
  id: string;
  title: string;
  description: string | null;
  type: string;
  state: WorkItemStateDto;
  priority: number; // 1 (highest) … 5 (lowest)
  effort: number | null;
  dueDate: string | null;
  assignee: string | null;
  recurrence: string | null;
  /** What created it, if anything (links back to the finding / anomaly / sync…). */
  source: WorkSourceDto | null;
  createdBy: string | null;
  links: WorkItemLinkDto[];
  labels: WorkLabelDto[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkCommentDto {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

/** One entry in a work item's history (from the audit trail). */
export interface WorkActivityDto {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  /** Human summary, e.g. "moved to In progress", "assigned to Priya". */
  summary: string;
}

export interface WorkItemDetailDto extends WorkItemDto {
  comments: WorkCommentDto[];
  activity: WorkActivityDto[];
}

/** Counts of open work items per state (board header / dashboard KPI). */
export interface WorkSummaryDto {
  total: number;
  byState: Record<WorkItemStateDto, number>;
  overdue: number;
}

// ── request schemas ──────────────────────────────────────────────

export const workScopeSchema = z.object({
  scopeType: z.enum(WORK_SCOPE_TYPES),
  scopeId: z.string().min(1),
  /** Optional label captured at creation for entities not in the estate. */
  scopeName: z.string().optional(),
});

export const workItemQuerySchema = z.object({
  state: z.enum(WORK_ITEM_STATES).optional(),
  type: z.string().optional(),
  assignee: z.string().optional(),
  scopeType: z.enum(WORK_SCOPE_TYPES).optional(),
  scopeId: z.string().optional(),
  /** Organization scoping (org switcher): items linked to this tenant or anything under it. */
  tenantId: z.string().optional(),
  search: z.string().trim().optional(),
  /** Items created from this source (e.g. every work item raised for one rule). */
  sourceType: z.string().max(40).optional(),
  sourceId: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});
export type WorkItemQuery = z.infer<typeof workItemQuerySchema>;

export const createWorkItemSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  type: z.string().default('task'),
  state: z.enum(WORK_ITEM_STATES).default('todo'),
  priority: z.coerce.number().int().min(1).max(5).default(3),
  effort: z.coerce.number().int().min(0).max(1000).optional(),
  dueDate: z.string().optional(),
  assignee: z.string().max(200).optional(),
  recurrence: z.enum(WORK_RECURRENCES).optional(),
  scope: workScopeSchema.optional(),
  /** Several scopes at once — e.g. every resource a finding affects. */
  scopes: z.array(workScopeSchema).max(50).optional(),
  source: z
    .object({ type: z.string().min(1).max(40), id: z.string().min(1).max(300), label: z.string().max(300).optional() })
    .optional(),
});
/** What a client sends (defaults applied server-side). */
export type CreateWorkItemRequest = z.input<typeof createWorkItemSchema>;
/** The parsed request, as the API sees it. */
export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;

export const updateWorkItemSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  type: z.string().optional(),
  state: z.enum(WORK_ITEM_STATES).optional(),
  priority: z.coerce.number().int().min(1).max(5).optional(),
  effort: z.coerce.number().int().min(0).max(1000).nullable().optional(),
  dueDate: z.string().nullable().optional(),
  assignee: z.string().max(200).nullable().optional(),
  recurrence: z.enum(WORK_RECURRENCES).nullable().optional(),
});
export type UpdateWorkItemRequest = z.infer<typeof updateWorkItemSchema>;

export const createCommentSchema = z.object({
  body: z.string().min(1).max(5000),
});
export type CreateCommentRequest = z.infer<typeof createCommentSchema>;
