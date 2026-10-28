import type { AccountConnResult, ProviderCapability } from '@cloudops/core';
import type { CredentialContext } from '@cloudops/credentials';

/**
 * One provider account's credentials, as entered in the Providers page. Keys are
 * provider-specific (Azure: name/tenantId/clientId/clientSecret) so the core can
 * pass them through without knowing any provider's auth shape.
 */
export type AccountCredentials = Record<string, string>;

/** Runtime context handed to every provider call. */
export interface ProviderContext {
  credential: CredentialContext;
  /** Structured logger provided by the host. */
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  signal?: AbortSignal;
  /**
   * Report a problem that did not stop the call but means part of the estate
   * was not reached — e.g. one organization's credentials were rejected while
   * the others synced. The host surfaces it (sync summary, notifications).
   */
  reportIssue?: (issue: { account?: string; message: string }) => void;
}

export interface ConnResult {
  ok: boolean;
  message: string;
  identity?: Record<string, string>;
}

/** A discoverable scope in the provider hierarchy (tenant -> subscription -> RG). */
export interface Scope {
  kind: 'tenant' | 'managementGroup' | 'subscription' | 'resourceGroup';
  externalId: string;
  name: string;
  parentExternalId?: string;
  location?: string;
  state?: string;
  metadata?: Record<string, unknown>;
}

/** A discovered resource in normalized, provider-agnostic form. */
export interface ResourceRecord {
  externalId: string; // globally unique provider id (e.g. Azure resource id)
  name: string;
  type: string; // e.g. 'Microsoft.Compute/virtualMachines'
  location?: string;
  sku?: string;
  tags?: Record<string, string>;
  subscriptionExternalId?: string;
  resourceGroupExternalId?: string;
  properties?: Record<string, unknown>;
  /** Owner, resolved from a configurable owner tag (default `Owner`). */
  owner?: string;
  /** Real creation time reported by the provider (ISO 8601), when available. */
  azureCreatedAt?: string;
  /** Typed relationships to other resources, discovered from properties. */
  relationships?: ResourceRelationshipRecord[];
}

export interface ResourceRelationshipRecord {
  type: 'depends-on' | 'network' | 'identity' | 'rbac' | 'contains';
  targetExternalId: string;
}

export interface ResourceDetail extends ResourceRecord {
  raw?: unknown;
}

/**
 * A change a provider can make to one resource (the `actions` capability).
 * Values come from the platform's action catalog, never from free user input.
 */
export type ProviderAction =
  | { kind: 'set-property'; externalId: string; path: string; value: string | number | boolean; apiVersion?: string }
  | { kind: 'power'; externalId: string; operation: 'start' | 'stop' | 'deallocate' | 'restart' }
  | { kind: 'delete'; externalId: string };

/** One entry from a provider's activity (audit) log for a resource. */
export interface ActivityEntry {
  at: string; // ISO
  operation: string;
  /** Who did it (user, service principal, or system). */
  caller: string | null;
  status: string | null;
  /** Provider correlation id, for following up in the provider's own tools. */
  correlationId: string | null;
}

export interface ProviderSecurityFinding {
  id: string;
  category: string;
  severity: string;
  state: string;
  description: string;
  resourceExternalId: string | null;
  detectedAt: string | null;
}

export interface ProviderMetricPoint {
  at: string;
  value: number;
}

export interface ProviderMetricSeries {
  resourceExternalId: string | null;
  metricType: string;
  points: ProviderMetricPoint[];
}

export interface ProviderRoleAssignment {
  role: string;
  member: string;
  scope: string;
  condition?: string;
}

export interface ProviderHealthEvent {
  id: string;
  title: string;
  description: string;
  state: string;
  category: string | null;
  relevance: string | null;
  severity: string | null;
  startTime: string | null;
  endTime: string | null;
}

export interface ProviderRecommendation {
  id: string;
  recommender: string;
  description: string;
  state: string;
  impact: string | null;
  resourceExternalId: string | null;
}

/** A day window for cost queries (ISO dates, inclusive). */
export interface CostQuery {
  from: string; // ISO date/time
  to: string; // ISO date/time
}

/** One resource's cost for one day, provider-normalized. */
export interface ProviderCostRecord {
  resourceExternalId: string; // lowercased provider resource id
  date: string; // YYYY-MM-DD
  cost: number;
  currency: string;
}

/**
 * The extensibility core. Every provider (Azure first; AWS/GCP/K8s/... later)
 * implements this interface. The core discovers providers through the registry
 * and never imports a provider concretely — adding one changes zero core code.
 */
export interface CloudProvider {
  readonly key: string; // 'azure' | 'aws' | 'gcp' | ...
  readonly displayName: string;
  readonly capabilities: ProviderCapability[];

  testConnection(ctx: ProviderContext): Promise<ConnResult>;

  /**
   * Optional: test each configured account/organization independently. Providers
   * that manage several accounts (e.g. Azure with one service principal per Entra
   * tenant) implement this to surface per-org read-access status before a sync.
   */
  testConnections?(ctx: ProviderContext): Promise<AccountConnResult[]>;

  /**
   * Optional: validate ONE account's credentials as entered in the UI, before
   * they are saved. Lets the Providers page verify a service principal without
   * writing it to the credential store first (and without a full sync).
   */
  testAccountCredentials?(
    account: AccountCredentials,
    ctx: ProviderContext,
  ): Promise<AccountConnResult>;

  /** Discover the scope hierarchy (tenants -> subscriptions -> resource groups). */
  discoverScopes(ctx: ProviderContext): AsyncIterable<Scope>;

  /** Discover resources within a subscription/resource-group scope. */
  discoverResources(scope: Scope, ctx: ProviderContext): AsyncIterable<ResourceRecord>;

  getResourceDetail(externalId: string, ctx: ProviderContext): Promise<ResourceDetail>;

  /**
   * Optional `cost` capability: per-resource, per-day cost for a subscription over
   * a window. Returns [] when the provider has no cost for the window. When the
   * query itself fails it throws — ideally a `CostQueryError` saying why — and
   * the FinOps sync keeps that subscription's existing data, records the reason
   * and carries on with the next one.
   */
  getCost?(
    subscriptionExternalId: string,
    query: CostQuery,
    ctx: ProviderContext,
  ): Promise<ProviderCostRecord[]>;

  /**
   * Optional `tags` capability (WRITE): set tags on a resource or resource group
   * by its ARM id via the Microsoft.Resources/tags API. `operation` is Merge
   * (add/update the given pairs), Delete (remove the given name=value pairs), or
   * Replace (set the exact set). Returns the entity's tag set after the operation.
   */
  updateResourceTags?(
    externalId: string,
    operation: 'Merge' | 'Delete' | 'Replace',
    tags: Record<string, string>,
    ctx: ProviderContext,
  ): Promise<Record<string, string>>;

  /**
   * Optional `actions` or `execution` capability: a side-effect-free preview of
   * the provider operation that would be performed.
   */
  previewAction?(action: ProviderAction): string;

  /**
   * Optional `actions` or `execution` capability (WRITE): perform one bounded
   * operation on one resource. Throws on failure; callers verify outcomes
   * through the provider's resource detail or operation API.
   */
  executeAction?(action: ProviderAction, ctx: ProviderContext): Promise<{ message?: string }>;

  /**
   * Optional `activity` capability: the provider's own record of operations on
   * a resource since `fromIso` — who changed it, when, and whether it worked.
   * Correlates detected drift with the change that caused it.
   */
  getActivity?(externalId: string, fromIso: string, ctx: ProviderContext): Promise<ActivityEntry[]>;

  getSecurityFindings?(
    projectExternalId: string,
    ctx: ProviderContext,
  ): Promise<ProviderSecurityFinding[]>;

  getMetrics?(
    projectExternalId: string,
    fromIso: string,
    toIso: string,
    ctx: ProviderContext,
  ): Promise<ProviderMetricSeries[]>;

  getRoleAssignments?(
    projectExternalId: string,
    ctx: ProviderContext,
  ): Promise<ProviderRoleAssignment[]>;

  getHealthEvents?(
    projectExternalId: string,
    ctx: ProviderContext,
  ): Promise<ProviderHealthEvent[]>;

  getRecommendations?(
    projectExternalId: string,
    ctx: ProviderContext,
  ): Promise<ProviderRecommendation[]>;
}
