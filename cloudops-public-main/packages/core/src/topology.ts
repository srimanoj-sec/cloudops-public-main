import { z } from 'zod';

/**
 * Topology (dependency-graph) contracts. The graph is built offline from
 * `ResourceRelationship` edges discovered during sync (network / identity / RBAC
 * / managed-by references found in each resource's properties). Read models power
 * the React/ECharts topology explorer, scoped per org / subscription / RG / type.
 */

/** Comma-separated relationship types (`network,identity`) → list. */
const relTypesParam = z
  .string()
  .optional()
  .transform((v) => {
    const list = v?.split(',').map((s) => s.trim()).filter(Boolean);
    return list && list.length ? list : undefined;
  });

/** Query params for the topology explorer (GET query string). Scope ids are DB ids. */
export const topologyQuerySchema = z.object({
  /** Organization = Tenant db id. */
  tenantId: z.string().optional(),
  subscriptionId: z.string().optional(),
  resourceGroupId: z.string().optional(),
  /** Optional Azure resource type filter (e.g. Microsoft.Compute/virtualMachines). */
  type: z.string().optional(),
  location: z.string().optional(),
  /** Service category (Compute, Network…). */
  category: z.string().optional(),
  /** Only these relationship types (default: all). */
  relTypes: relTypesParam,
  /** Max primary nodes to return before the graph is flagged truncated. */
  limit: z.coerce.number().int().positive().max(2000).optional(),
});
export type TopologyQuery = z.infer<typeof topologyQuerySchema>;

/** Focus mode: a resource and what's connected to it, N hops out. */
export const topologyNeighborhoodSchema = z.object({
  depth: z.coerce.number().int().min(1).max(3).default(1),
  /** out = what it depends on · in = what depends on it · both. */
  direction: z.enum(['both', 'out', 'in']).default('both'),
  relTypes: relTypesParam,
});
export type TopologyNeighborhoodQuery = z.infer<typeof topologyNeighborhoodSchema>;

export const TOPOLOGY_CLUSTER_BY = ['resourceGroup', 'subscription', 'category', 'type', 'location'] as const;
export type TopologyClusterBy = (typeof TOPOLOGY_CLUSTER_BY)[number];

export const topologyClusterQuerySchema = topologyQuerySchema.extend({
  groupBy: z.enum(TOPOLOGY_CLUSTER_BY).default('resourceGroup'),
});
export type TopologyClusterQuery = z.infer<typeof topologyClusterQuerySchema>;

/** One cluster (a resource group, subscription, category…) in the map view. */
export interface TopologyClusterDto {
  /** Group key; pass back as the matching filter to drill in. */
  id: string;
  label: string;
  /** Where it lives (a resource group's subscription). */
  context: string | null;
  resources: number;
  costMonthly: number;
  /** The category most of its resources belong to (drives the colour). */
  category: TopologyCategory;
  /** Resources with high-severity failing compliance checks. */
  failing: number;
  /** Outside the current scope, pulled in by a cross-scope edge. */
  external: boolean;
}

export interface TopologyClusterLinkDto {
  source: string;
  target: string;
  count: number;
  /** Edge count per relationship type. */
  types: Record<string, number>;
}

export interface TopologyClusterResult {
  groupBy: TopologyClusterBy;
  /** Reporting currency of costMonthly. */
  currency: string;
  clusters: TopologyClusterDto[];
  links: TopologyClusterLinkDto[];
  stats: { resources: number; clusters: number; edges: number };
}

/** Relationship kinds persisted on `ResourceRelationship.type`. */
export const RELATIONSHIP_TYPES = ['depends-on', 'network', 'identity', 'rbac', 'contains'] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/**
 * Service buckets a resource type is grouped into for the topology legend +
 * colour coding. The legend doubles as a per-service filter (toggle a category).
 */
export const TOPOLOGY_CATEGORIES = [
  'Compute',
  'Web/App',
  'Containers',
  'Database',
  'Storage',
  'Network',
  'AI + ML',
  'Integration',
  'Analytics',
  'Monitoring',
  'Security',
  'Identity',
  'Management',
  'Other',
] as const;
export type TopologyCategory = (typeof TOPOLOGY_CATEGORIES)[number];

/** Namespace → category. Anything unlisted is "Other". */
const NAMESPACE_CATEGORY: Record<string, TopologyCategory> = {
  'microsoft.compute': 'Compute',
  'microsoft.desktopvirtualization': 'Compute',
  'microsoft.batch': 'Compute',
  'microsoft.web': 'Web/App',
  'microsoft.appconfiguration': 'Web/App',
  'microsoft.signalrservice': 'Web/App',
  'microsoft.app': 'Containers',
  'microsoft.containerservice': 'Containers',
  'microsoft.containerregistry': 'Containers',
  'microsoft.containerinstance': 'Containers',
  'microsoft.kubernetes': 'Containers',
  'microsoft.sql': 'Database',
  'microsoft.documentdb': 'Database',
  'microsoft.cache': 'Database',
  'microsoft.dbformysql': 'Database',
  'microsoft.dbforpostgresql': 'Database',
  'microsoft.dbformariadb': 'Database',
  'mongodb.atlas': 'Database',
  'microsoft.storage': 'Storage',
  'microsoft.storagesync': 'Storage',
  'microsoft.netapp': 'Storage',
  'microsoft.network': 'Network',
  'microsoft.cdn': 'Network',
  'microsoft.cognitiveservices': 'AI + ML',
  'microsoft.machinelearningservices': 'AI + ML',
  'microsoft.botservice': 'AI + ML',
  'microsoft.search': 'AI + ML',
  'microsoft.servicebus': 'Integration',
  'microsoft.eventhub': 'Integration',
  'microsoft.eventgrid': 'Integration',
  'microsoft.logic': 'Integration',
  'microsoft.apimanagement': 'Integration',
  'microsoft.relay': 'Integration',
  'microsoft.communication': 'Integration',
  'microsoft.synapse': 'Analytics',
  'microsoft.datafactory': 'Analytics',
  'microsoft.streamanalytics': 'Analytics',
  'microsoft.databricks': 'Analytics',
  'microsoft.kusto': 'Analytics',
  'microsoft.fabric': 'Analytics',
  'microsoft.insights': 'Monitoring',
  'microsoft.operationalinsights': 'Monitoring',
  'microsoft.alertsmanagement': 'Monitoring',
  'microsoft.operationsmanagement': 'Monitoring',
  'microsoft.dashboard': 'Monitoring',
  'microsoft.portal': 'Monitoring',
  'microsoft.keyvault': 'Security',
  'microsoft.security': 'Security',
  'microsoft.managedidentity': 'Identity',
  'microsoft.aad': 'Identity',
  'microsoft.authorization': 'Identity',
  'microsoft.management': 'Management',
  'microsoft.resources': 'Management',
  'microsoft.automation': 'Management',
  'microsoft.recoveryservices': 'Management',
  'microsoft.dataprotection': 'Management',
  'microsoft.visualstudio': 'Management',
  'microsoft.maintenance': 'Management',
};

/** Map an Azure resource type to a coarse service category (namespace-driven). */
export function categoryForType(type: string | null | undefined): TopologyCategory {
  const lowerType = (type ?? '').toLowerCase();
  if (lowerType.startsWith('microsoft.network/azurefirewalls') || lowerType.startsWith('microsoft.network/firewallpolicies')) return 'Security';
  const ns = lowerType.split('/')[0] ?? '';
  return NAMESPACE_CATEGORY[ns] ?? 'Other';
}

export interface TopologyNodeDto {
  id: string; // Resource db id
  externalId: string;
  name: string;
  type: string;
  category: TopologyCategory;
  subscriptionId: string | null;
  resourceGroupId: string | null;
  owner: string | null;
  costMonthly: number | null;
  location?: string | null;
  /** Failing (non-exempt) compliance checks, and the worst severity among them. */
  failingChecks?: number;
  worstSeverity?: string | null;
  /** True = outside the current scope filter, pulled in as a connected neighbour. */
  external: boolean;
  /** Focus mode: hops from the focused resource (0 = the resource itself). */
  hop?: number;
}

export interface TopologyEdgeDto {
  id: string;
  source: string; // source node id
  target: string; // target node id
  type: string; // RelationshipType
}

export interface TopologyStats {
  /** Resources matching the scope filter (before the render cap). */
  total: number;
  /** Primary (in-scope) nodes rendered. */
  shown: number;
  /** External neighbour nodes pulled in by cross-scope edges. */
  neighbors: number;
  edges: number;
  /** True when `total` exceeds `shown` — narrow the scope to see everything. */
  truncated: boolean;
  limit: number;
}

export interface TopologyResult {
  /** Reporting currency of the nodes' costMonthly. */
  currency: string;
  nodes: TopologyNodeDto[];
  edges: TopologyEdgeDto[];
  /** Categories actually present, for building the legend. */
  categories: TopologyCategory[];
  /**
   * Distinct resource types present in the current scope (org/subscription/RG),
   * ignoring the `type` filter itself — so the type dropdown only offers types
   * that actually exist in scope and never collapses to the selected one.
   */
  types: string[];
  stats: TopologyStats;
  /** Set in focus mode. */
  focus?: { id: string; depth: number; direction: 'both' | 'out' | 'in' };
}
