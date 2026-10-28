import type { ResourceRecord, ResourceRelationshipRecord, Scope } from '@cloudops/provider-sdk';

export interface AzSubscription {
  id: string;
  name: string;
  tenantId: string;
  state: string;
}

export interface AzResourceGroup {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string> | null;
}

/** Azure managed-identity block (`type` + optional user-assigned identity ids). */
export type AzIdentity = { type?: string; [key: string]: unknown } | null;

export interface AzResource {
  id: string;
  name: string;
  type: string;
  location?: string;
  sku?: { name?: string } | null;
  tags?: Record<string, string> | null;
  resourceGroup?: string;
  managedBy?: string;
  identity?: AzIdentity;
}

/** A row returned by an Azure Resource Graph `Resources` query (see graph.ts). */
export interface AzGraphResource {
  id: string;
  name: string;
  type: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  sku?: { name?: string } | string | null;
  tags?: Record<string, string> | null;
  identity?: AzIdentity;
  managedBy?: string | null;
  properties?: Record<string, unknown> | null;
}

export const DEFAULT_OWNER_TAG = 'Owner';

/** Resolve the owner from tags by a case-insensitive tag-name match. */
export function ownerFromTags(
  tags: Record<string, string> | null | undefined,
  ownerTag: string = DEFAULT_OWNER_TAG,
): string | undefined {
  if (!tags) return undefined;
  const target = ownerTag.toLowerCase();
  for (const [k, v] of Object.entries(tags)) {
    if (k.toLowerCase() === target && v) return v;
  }
  return undefined;
}

// Property paths (in priority order) that hold a real creation timestamp across
// common Azure resource types. Resource Graph exposes these on `properties`.
const CREATED_TIME_KEYS = ['createdTime', 'timeCreated', 'creationTime', 'createdDate', 'provisioningTime'];

/** Best-effort extraction of a creation timestamp from a properties bag → ISO string. */
export function extractCreatedTime(properties: Record<string, unknown> | null | undefined): string | undefined {
  if (!properties) return undefined;
  for (const key of CREATED_TIME_KEYS) {
    const raw = properties[key];
    if (typeof raw === 'string' || typeof raw === 'number') {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return undefined;
}

/** Extract the subscription id segment from an Azure resource id. */
export function subscriptionIdFromResourceId(id: string): string | undefined {
  const m = /\/subscriptions\/([^/]+)/i.exec(id);
  return m?.[1];
}

/** Build the canonical resource-group external id used across the platform. */
export function resourceGroupExternalId(subscriptionId: string, rgName: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${rgName}`.toLowerCase();
}

// ── Relationship (topology) discovery ────────────────────────────
// Azure resources reference each other by resource id inside their properties
// (a NIC → its subnet/NSG/publicIP, a VM → its NICs/disks, a private endpoint →
// its target, a managed identity assignment, …). We scan a serialized view of
// each resource's properties/identity/managedBy for resource ids and emit a typed
// edge to the *top-level* resource each id belongs to. This is provider-general
// (no per-type hand-coding) and captures the bulk of real dependency topology.

// A resource id fragment: `/subscriptions/…` up to the next quote/space/backslash.
// Anything containing `/providers/` is a resource (vs. a bare subscription/RG id).
const RESOURCE_ID_RE = /\/subscriptions\/[^"'\s\\]+/gi;

// Captures through the first type/name pair after `/providers/` — i.e. the
// top-level resource. A nested id like `…/virtualNetworks/vnet/subnets/default`
// truncates to `…/virtualNetworks/vnet`, which is what inventory actually holds.
const TOP_LEVEL_RE =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/[^/]+\/[^/]+\/[^/]+/i;

/** Truncate any (possibly nested) Azure resource id to its top-level resource id. */
export function topLevelResourceId(id: string): string {
  const m = TOP_LEVEL_RE.exec(id);
  return m ? m[0] : id;
}

/** Classify an edge from the referenced resource's provider namespace. */
export function classifyRelationship(targetId: string): ResourceRelationshipRecord['type'] {
  const ns = /\/providers\/([^/]+)\//i.exec(targetId)?.[1]?.toLowerCase() ?? '';
  if (ns === 'microsoft.network') return 'network';
  if (ns === 'microsoft.managedidentity') return 'identity';
  if (ns === 'microsoft.authorization') return 'rbac';
  return 'depends-on';
}

/**
 * Extract typed relationship edges from a resource's reference-bearing fields.
 * Targets are returned as lowercased top-level resource ids (deduped, self
 * excluded). The sync engine resolves them against inventory and drops any that
 * point outside the estate.
 */
export function extractRelationships(record: {
  id: string;
  properties?: Record<string, unknown> | null;
  identity?: AzIdentity;
  managedBy?: string | null;
}): ResourceRelationshipRecord[] {
  const self = topLevelResourceId(record.id).toLowerCase();
  const blob = JSON.stringify({
    p: record.properties ?? null,
    i: record.identity ?? null,
    m: record.managedBy ?? null,
  });
  const found = new Map<string, ResourceRelationshipRecord['type']>();
  for (const match of blob.matchAll(RESOURCE_ID_RE)) {
    const raw = match[0];
    if (!/\/providers\//i.test(raw)) continue; // skip bare subscription/RG ids
    const target = topLevelResourceId(raw).toLowerCase();
    if (target === self || found.has(target)) continue;
    found.set(target, classifyRelationship(target));
  }
  return [...found].map(([targetExternalId, type]) => ({ type, targetExternalId }));
}

export function mapSubscription(s: AzSubscription): Scope {
  return {
    kind: 'subscription',
    externalId: s.id,
    name: s.name,
    parentExternalId: s.tenantId,
    state: s.state,
    metadata: { tenantId: s.tenantId },
  };
}

export function mapResourceGroup(rg: AzResourceGroup, subscriptionId: string): Scope {
  return {
    kind: 'resourceGroup',
    // Normalize to lowercase so resource -> RG linkage always matches.
    externalId: rg.id.toLowerCase(),
    name: rg.name,
    parentExternalId: subscriptionId,
    location: rg.location,
    metadata: rg.tags ? { tags: rg.tags } : undefined,
  };
}

export function mapResource(r: AzResource, ownerTag: string = DEFAULT_OWNER_TAG): ResourceRecord {
  const subscriptionExternalId = subscriptionIdFromResourceId(r.id);
  const rgExternalId =
    r.resourceGroup && subscriptionExternalId
      ? resourceGroupExternalId(subscriptionExternalId, r.resourceGroup)
      : undefined;

  return {
    externalId: r.id,
    name: r.name,
    type: r.type,
    location: r.location,
    sku: r.sku?.name ?? undefined,
    tags: r.tags ?? {},
    owner: ownerFromTags(r.tags, ownerTag),
    // Subscription external id is the bare subscription guid (matches Scope.externalId).
    subscriptionExternalId,
    resourceGroupExternalId: rgExternalId,
    properties: {
      identityType: r.identity?.type ?? null,
      managedBy: r.managedBy ?? null,
    },
    relationships: extractRelationships({ id: r.id, identity: r.identity, managedBy: r.managedBy }),
  };
}

/**
 * Map an Azure Resource Graph row to a normalized ResourceRecord. Richer than
 * `mapResource`: carries the real creation time and the full properties bag, all
 * from a single fast query instead of per-resource calls.
 */
export function mapGraphResource(r: AzGraphResource, ownerTag: string = DEFAULT_OWNER_TAG): ResourceRecord {
  const subscriptionExternalId = r.subscriptionId ?? subscriptionIdFromResourceId(r.id);
  const rgExternalId =
    r.resourceGroup && subscriptionExternalId
      ? resourceGroupExternalId(subscriptionExternalId, r.resourceGroup)
      : undefined;

  const sku = typeof r.sku === 'string' ? r.sku : (r.sku?.name ?? undefined);
  const properties = r.properties ?? {};

  return {
    externalId: r.id,
    name: r.name,
    type: r.type,
    location: r.location,
    sku,
    tags: r.tags ?? {},
    owner: ownerFromTags(r.tags, ownerTag),
    azureCreatedAt: extractCreatedTime(properties),
    subscriptionExternalId,
    resourceGroupExternalId: rgExternalId,
    properties: {
      ...properties,
      identityType: r.identity?.type ?? null,
      managedBy: r.managedBy ?? null,
    },
    relationships: extractRelationships({
      id: r.id,
      properties,
      identity: r.identity,
      managedBy: r.managedBy,
    }),
  };
}
