import { z } from 'zod';

/**
 * Global search: one query across the estate and the platform's own records.
 * Results are grouped by kind; each carries a route to open it and a few
 * preview facts, so the command palette can show a preview without another call.
 */

export const SEARCH_KINDS = [
  'resource',
  'resourceGroup',
  'subscription',
  'organization',
  'workItem',
  'rule',
  'document',
  'remediation',
  'syncRun',
  'user',
  'audit',
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  resource: 'Resources',
  resourceGroup: 'Resource groups',
  subscription: 'Subscriptions',
  organization: 'Organizations',
  workItem: 'Work items',
  rule: 'Standards rules',
  document: 'Documents',
  remediation: 'Remediations',
  syncRun: 'Syncs',
  user: 'Users',
  audit: 'Audit events',
};

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  /** Restrict to these kinds (comma-separated). */
  kinds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter((s): s is SearchKind => (SEARCH_KINDS as readonly string[]).includes(s)) : undefined)),
  /** Results per kind. */
  limit: z.coerce.number().int().min(1).max(25).default(6),
  /** Organization scope (global org switcher). */
  tenantId: z.string().optional(),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export interface SearchResultDto {
  kind: SearchKind;
  id: string;
  title: string;
  /** One line of context (type · location, parent scope…). */
  subtitle: string | null;
  /** In-app route. */
  link: string;
  /** Why it matched when it wasn't the title (e.g. "resource id", "tag env=prod", "IP 10.0.0.4"). */
  matched: string | null;
  /** Preview facts: label → value. */
  facts: { label: string; value: string }[];
  /** Status chip (lifecycle, state, severity…). */
  badge: { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'accent' } | null;
}

export interface SearchGroupDto {
  kind: SearchKind;
  label: string;
  items: SearchResultDto[];
  /** True when there are more matches than returned. */
  more: boolean;
}

export interface SearchResponseDto {
  query: string;
  groups: SearchGroupDto[];
  tookMs: number;
}
