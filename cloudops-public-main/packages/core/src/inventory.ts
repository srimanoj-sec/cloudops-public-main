import { z } from 'zod';
import { paginationQuerySchema } from './pagination.js';
import type { ResourceState } from './enums.js';

/** Comma-separated query param → trimmed string[] (undefined when absent/empty). */
const csvArray = z
  .string()
  .optional()
  .transform((v) => {
    const parts = v?.split(',').map((s) => s.trim()).filter(Boolean);
    return parts && parts.length ? parts : undefined;
  });

/** Server-side sort keys for the resource list. */
export const INVENTORY_SORTS = ['name', 'type', 'location', 'cost', 'created', 'resourceGroup'] as const;
export type InventorySort = (typeof INVENTORY_SORTS)[number];

/**
 * Query filters for the inventory explorer (offline, Postgres-backed). Multi-select
 * filters are comma-separated (`types=a,b`). The legacy single-value params
 * (`type`, `location`, `subscriptionId`, `owner`, `state`) are kept for existing
 * deep-links; the plural forms take precedence when both are present.
 */
export const resourceQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(200).optional(),
  // Legacy single-value (deep-links).
  type: z.string().optional(),
  location: z.string().optional(),
  owner: z.string().optional(),
  state: z.enum(['active', 'deleted']).optional(),
  // Scope.
  /** Organization = Tenant db id (an Entra tenant synced via a service principal). */
  tenantId: z.string().optional(),
  subscriptionId: z.string().optional(),
  resourceGroupId: z.string().optional(),
  environment: z.string().optional(),
  // Multi-select (comma-separated).
  types: csvArray,
  locations: csvArray,
  owners: csvArray,
  subscriptionIds: csvArray,
  lifecycleStages: csvArray,
  states: csvArray,
  /** Tag filters, each `key:value` (AND-combined). */
  tags: csvArray,
  /** Service categories (Compute, Web/App, …) — see categoryForType. */
  categories: csvArray,
  sort: z.enum(INVENTORY_SORTS).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ResourceQuery = z.infer<typeof resourceQuerySchema>;

/** Group the (filtered) inventory by one of these. */
export const INVENTORY_GROUP_BY = ['organization', 'subscription', 'resourceGroup', 'category', 'type', 'location', 'owner'] as const;
export type InventoryGroupBy = (typeof INVENTORY_GROUP_BY)[number];

export const inventoryGroupsQuerySchema = resourceQuerySchema.extend({ groupBy: z.enum(INVENTORY_GROUP_BY) });
export type InventoryGroupsQuery = z.infer<typeof inventoryGroupsQuerySchema>;

/** One group of the filtered inventory. `filter` narrows the resource list to it. */
export interface InventoryGroupDto {
  key: string;
  label: string;
  /** Where the group lives, e.g. a resource group's "Org › Subscription". */
  context: string | null;
  count: number;
  /** Sum of the members' trailing-30-day cost. */
  costMonthly: number;
  /** Query params that select exactly this group's resources. */
  filter: Record<string, string>;
}

export interface InventoryGroupsDto {
  groupBy: InventoryGroupBy;
  total: number;
  groups: InventoryGroupDto[];
  costCurrency: string;
}

/** Org → subscription → resource group, with resource counts, for the scope navigator. */
export interface InventoryTreeDto {
  organizations: {
    id: string | null;
    name: string;
    count: number;
    subscriptions: {
      id: string;
      name: string;
      count: number;
      resourceGroups: { id: string; name: string; count: number }[];
    }[];
  }[];
}

/**
 * An Organization is one Entra tenant discovered via a service principal. It is
 * persisted as a `Tenant` row; the DTO rolls up its subscriptions/RGs/resources.
 */
export interface OrganizationDto {
  id: string;
  externalId: string; // Entra tenant id
  name: string;
  providerKey: string;
  subscriptionCount: number;
  resourceGroupCount: number;
  resourceCount: number;
  lastSyncedAt: string | null;
}

export interface SubscriptionDto {
  id: string;
  externalId: string;
  name: string;
  tenantId: string | null;
  /** Human-readable org name (from the Tenant), when linked. */
  organizationName: string | null;
  state: string | null;
  resourceGroupCount?: number;
  resourceCount?: number;
  /** 7-day average daily cost (rolled up from CostRecord); null when no cost data. */
  dailyCost?: number | null;
  costCurrency?: string | null;
}

/** Distinct filter facets for the inventory explorer. */
export interface FacetsDto {
  types: string[];
  locations: string[];
  organizations: { id: string; name: string }[];
  owners: string[];
  lifecycleStages: string[];
  subscriptions: { id: string; name: string }[];
  /** Distinct tag keys present across resources (for the tag filter). */
  tagKeys: string[];
}

export interface ResourceGroupDto {
  id: string;
  externalId: string;
  name: string;
  location: string | null;
  subscriptionId: string;
  subscriptionName: string | null;
  resourceCount?: number;
  /** The RG's own Azure tags (synced). */
  tags?: Record<string, string>;
  /** 7-day average daily cost across the RG's resources; null when no cost data. */
  dailyCost?: number | null;
  costCurrency?: string | null;
}

export interface ResourceDto {
  id: string;
  externalId: string;
  name: string;
  type: string;
  providerKey: string;
  location: string | null;
  sku: string | null;
  state: ResourceState;
  tags: Record<string, string>;
  /** Tags stored only in CloudOps (for resources Azure can't tag). */
  platformTags: Record<string, string> | null;
  /** null = untested, true = taggable in Azure, false = Azure rejects tags for this type. */
  taggableInAzure: boolean | null;
  owner: string | null;
  /** Real Azure creation time (ISO), when the provider could resolve it. */
  azureCreatedAt: string | null;
  /** Planned decommission date (user-set). */
  retireBy: string | null;
  /** Whether the resource is actually in use (null = unknown; populated later). */
  inUse: boolean | null;
  costDaily: number | null;
  costMonthly: number | null;
  /** 7-day average daily cost (rolled up from CostRecord); null when no cost data. */
  dailyCost?: number | null;
  costCurrency?: string | null;
  subscriptionId: string | null;
  resourceGroupId: string | null;
  /** Where it lives — shown on every row so a resource is never out of context. */
  organizationId?: string | null;
  organizationName?: string | null;
  subscriptionName?: string | null;
  resourceGroupName?: string | null;
  /** Service category (Compute, Web/App, AI + ML…). */
  category?: string;
  /** Failing (non-exempt) compliance checks, and the worst severity among them. */
  failingChecks?: number;
  worstSeverity?: string | null;
  lifecycleStage: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceDetailDto extends ResourceDto {
  properties: Record<string, unknown>;
  /** What this resource depends on (outgoing edges). */
  relationships: ResourceRelationshipDto[];
  /** What depends on this resource (incoming edges) — its blast radius. */
  dependents: ResourceDependentDto[];
  /** Deep link to the resource in the provider's console, when known. */
  portalUrl: string | null;
}

export interface ResourceDependentDto {
  id: string;
  type: string;
  sourceResourceId: string;
  sourceName?: string;
}

export const RESOURCE_ACTIVITY_KINDS = ['change', 'lifecycle', 'audit', 'remediation', 'work', 'exemption'] as const;
export type ResourceActivityKind = (typeof RESOURCE_ACTIVITY_KINDS)[number];

/** One entry in a resource's activity timeline — every source merged, newest first. */
export interface ResourceActivityDto {
  id: string;
  at: string;
  kind: ResourceActivityKind;
  title: string;
  detail: string | null;
  actor: string | null;
  /** Where to see more (a work item, a remediation run, a sync run…). */
  link: string | null;
}

/** Result of re-reading one resource from the provider. */
export interface ResourceRefreshResultDto {
  found: boolean;
  /** Fields that differed from the cached copy (tags, sku, location, configuration). */
  changed: string[];
  message: string;
}

export interface ResourceRelationshipDto {
  id: string;
  type: string;
  targetResourceId: string;
  targetName?: string;
}

/** One asset-lifecycle stage transition (Created → Modified → … → Deleted). */
export interface LifecycleEventDto {
  id: string;
  stage: string;
  actor: string | null;
  reason: string | null;
  createdAt: string;
}

/** One detected field-level change (drift / audit history). */
export interface ChangeEventDto {
  id: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  syncRunId: string | null;
  detectedAt: string;
}

/** Full history for a resource: lifecycle timeline + change/audit feed. */
export interface ResourceHistoryDto {
  lifecycleEvents: LifecycleEventDto[];
  changeEvents: ChangeEventDto[];
}

/**
 * One field-level change attributed to a specific sync run, enriched with the
 * resource it happened on. Powers the "what changed" drilldown on a sync run.
 */
export interface SyncRunChangeDto {
  id: string;
  resourceId: string;
  resourceName: string | null;
  resourceType: string | null;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  detectedAt: string;
}

export const syncRequestSchema = z.object({
  providerKey: z.string().default('azure'),
  /** Optional subscription filter; omitted = all discoverable scopes. */
  subscriptionId: z.string().optional(),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

/** Per-organization rollup for a single sync run. */
export interface SyncOrgSummary {
  organization: string; // org (Entra tenant) name, or tenant id / 'default'
  tenantId?: string;
  subscriptions: number;
  resources: number; // resources discovered across the org's subscriptions
  skipped: string[]; // subscriptions skipped, with reason
}

/** Structured result of a sync run, grouped by organization. */
export interface SyncSummary {
  orgs: SyncOrgSummary[];
  totalSubscriptions: number;
  skipped: string[];
  /** Resources no longer present in the provider that this run marked deleted. */
  deleted?: number;
  /** Subscriptions where deletion marking was skipped as a safety measure, with reason. */
  deletionSkipped?: string[];
  /** Organizations the provider could not reach at all (e.g. rejected credentials). */
  accountErrors?: { account: string; message: string }[];
}

export interface SyncRunDto {
  id: string;
  providerKey: string;
  status: string;
  scope: string | null;
  created: number;
  updated: number;
  changes: number;
  /** Resources this run marked deleted (they vanished from the provider). */
  deleted: number;
  error: string | null;
  summary: SyncSummary | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** Who started it (null = the scheduler / automation). */
  triggeredBy?: string | null;
  /** Wall-clock run time, once finished. */
  durationMs?: number | null;
  /** True when a sync was already queued/running and that run was returned instead. */
  deduplicated?: boolean;
}

export const syncRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
  /** Runs created before this run's creation (cursor paging). */
  before: z.string().optional(),
});
export type SyncRunsQuery = z.infer<typeof syncRunsQuerySchema>;

/** Result of testing a single provider account/organization's connectivity. */
export interface AccountConnResult {
  account: string; // org/account display name
  ok: boolean;
  message: string;
  tenantId?: string;
  subscriptions?: number;
}

export interface ProviderTestResult {
  ok: boolean; // true only when every account connected
  accounts: AccountConnResult[];
}

// ── Tag management (write-back to Azure) ──────────────────────────

/**
 * Azure tag-name constraints (≤ 512 chars, none of `< > % & \ ? /`), plus two of
 * ours: tags reach `az` as `name=value` arguments, so a name may not contain
 * `=` (unrepresentable) or start with `-` (az would parse `--operation=replace`
 * as a flag, not as a tag).
 */
const tagName = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^<>%&\\?/=]+$/, 'tag name has an invalid character')
  .refine((v) => !v.startsWith('-'), 'tag name cannot start with "-"');

/** Azure allows at most 50 tags per resource / resource group. */
export const MAX_TAGS = 50;
const withinTagLimit = (tags: Record<string, string>) => Object.keys(tags).length <= MAX_TAGS;

const tagRecord = z.record(tagName, z.string().max(256)).refine(withinTagLimit, `At most ${MAX_TAGS} tags`);

/** Set the FULL desired tag set on a single resource (add/edit/remove all at once). */
export const setResourceTagsSchema = z.object({ tags: tagRecord });
export type SetResourceTagsRequest = z.infer<typeof setResourceTagsSchema>;

/** Apply (merge) these tags onto a resource group and every resource in it. */
export const applyResourceGroupTagsSchema = z.object({
  tags: z.record(tagName, z.string().min(1).max(256)).refine(withinTagLimit, `At most ${MAX_TAGS} tags`),
});
export type ApplyResourceGroupTagsRequest = z.infer<typeof applyResourceGroupTagsSchema>;

/** Result of writing tags to a single resource. */
export interface TagWriteResult {
  /** True when the tags were written to Azure; false when stored in CloudOps only. */
  appliedToAzure: boolean;
  taggableInAzure: boolean | null;
  tags: Record<string, string>;
  platformTags: Record<string, string> | null;
  message?: string;
}

/** Result of a resource-group tag cascade (apply-once to current resources). */
export interface ResourceGroupTagResult {
  rgApplied: boolean;
  total: number;
  tagged: number; // written to Azure
  platformOnly: number; // stored in CloudOps (untaggable)
  failed: number;
  errors: { resource: string; message: string }[];
  tags: Record<string, string>; // the RG's tags after the merge
}

/** Background RG tag-apply job (POST …/resource-groups/:id/tags/jobs). */
export interface TagJobDto {
  id: string;
  resourceGroupId: string;
  state: 'queued' | 'running' | 'completed' | 'failed';
  progress: { done: number; total: number };
  result: ResourceGroupTagResult | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** True when a job for this resource group was already in progress and is returned instead. */
  deduplicated?: boolean;
}
