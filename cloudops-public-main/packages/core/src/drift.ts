import { z } from 'zod';

/**
 * Configuration drift: field-level changes the sync (or a refresh) detected on
 * resources — who/what changed, from what to what, and when. The provider's
 * activity log is consulted on demand to say who made the change.
 */

export const driftQuerySchema = z.object({
  field: z.string().max(60).optional(),
  resourceId: z.string().max(64).optional(),
  /** Changes one sync run found. */
  syncRunId: z.string().max(64).optional(),
  tenantId: z.string().optional(),
  subscriptionId: z.string().optional(),
  search: z.string().trim().max(200).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type DriftQuery = z.infer<typeof driftQuerySchema>;

export interface DriftChangeDto {
  id: string;
  resourceId: string;
  resourceName: string | null;
  resourceType: string | null;
  subscription: string | null;
  resourceGroup: string | null;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  detectedAt: string;
  /** The sync run that found it; null when found by a manual refresh. */
  syncRunId: string | null;
}

export interface DriftListDto {
  items: DriftChangeDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** How many changes per field, in the current scope (ignores the field filter). */
  fields: { field: string; count: number }[];
}

export interface ActivityEntryDto {
  at: string;
  operation: string;
  caller: string | null;
  status: string | null;
  correlationId: string | null;
}

/** Who changed it: the provider's activity log around the detection. */
export interface DriftActivityDto {
  available: boolean;
  /** Why the log isn't available (no permission, provider lacks the capability…). */
  reason: string | null;
  window: { from: string; to: string };
  entries: ActivityEntryDto[];
}
