import { z } from 'zod';

/**
 * Saved views — named, reusable filter sets for an explorer page (inventory
 * first). Shared across the team. `filters` is an opaque serialized query state
 * that the owning page knows how to apply.
 */

export interface SavedViewDto {
  id: string;
  name: string;
  scope: string;
  filters: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const savedViewQuerySchema = z.object({
  scope: z.string().default('inventory'),
});
export type SavedViewQuery = z.infer<typeof savedViewQuerySchema>;

export const createSavedViewSchema = z.object({
  name: z.string().min(1).max(120),
  scope: z.string().default('inventory'),
  filters: z.record(z.unknown()).default({}),
});
export type CreateSavedViewRequest = z.infer<typeof createSavedViewSchema>;

export const updateSavedViewSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  filters: z.record(z.unknown()).optional(),
});
export type UpdateSavedViewRequest = z.infer<typeof updateSavedViewSchema>;
