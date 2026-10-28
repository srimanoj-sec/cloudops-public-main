/**
 * Cross-cutting enums shared by api and web. Kept as const arrays + unions so
 * they can be reused for Zod enums and TS types alike.
 */

export const ENVIRONMENT_TYPES = ['Production', 'Stage', 'QA', 'Dev', 'Sandbox'] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

export const LIFECYCLE_STAGES = [
  'Created',
  'Modified',
  'Migrated',
  'Deprecated',
  'Retired',
  'Deleted',
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const PROVIDER_CAPABILITIES = [
  'inventory',
  'relationships',
  'cost',
  'tags',
  'actions',
  'activity',
  'security',
  'metrics',
  'rbac',
  'health',
  'recommendations',
  'execution',
] as const;

/** What each capability means, for the provider capability matrix. */
export const PROVIDER_CAPABILITY_INFO: Record<(typeof PROVIDER_CAPABILITIES)[number], { label: string; description: string }> = {
  inventory: { label: 'Inventory', description: 'Discovers organizations, subscriptions, resource groups and resources.' },
  relationships: { label: 'Relationships', description: 'Network, identity and dependency edges for the topology.' },
  cost: { label: 'Cost', description: 'Daily cost per resource.' },
  tags: { label: 'Tag write-back', description: 'Writes tags to resources (needs write access).' },
  actions: { label: 'Actions', description: 'Remediations and operations: property changes, power, deletion (needs write access).' },
  activity: { label: 'Activity log', description: 'Who changed a resource and when — correlates drift with its cause.' },
  security: { label: 'Security alerts', description: 'The provider’s own security findings.' },
  metrics: { label: 'Metrics', description: 'Utilization metrics (CPU, requests…) for idle detection.' },
  rbac: { label: 'Access (RBAC)', description: 'Role assignments.' },
  health: { label: 'Service health', description: 'Provider-reported resource health.' },
  recommendations: { label: 'Recommendations', description: 'The provider’s own advisor recommendations.' },
  execution: { label: 'Execution', description: 'Runs provider-supported operations on resources; available operations vary by provider.' },
};
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const RESOURCE_STATES = ['active', 'deleted'] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

export const SYNC_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Built-in role keys — see ROLE_DEFINITIONS (permissions.ts) for what each grants. */
export const ROLES = ['admin', 'operator', 'finops', 'security', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const WORK_ITEM_STATES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];
