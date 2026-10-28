/**
 * Permission catalog. Every permission maps to real operations the API exposes;
 * routes check permissions (never role names), and roles are just named bundles
 * of permissions. The web app receives the caller's effective permissions so it
 * never offers an action the API would refuse.
 *
 * Reading the estate (inventory, topology, cost, compliance, work, docs) is open
 * to every signed-in user — the platform has no per-scope data isolation yet, so
 * a "read" permission would be decoration. Permissions gate what changes things
 * and what exposes other people's data (users, audit, system internals).
 */

export const PERMISSIONS = {
  'inventory.sync': 'Run inventory syncs against the cloud provider',
  'inventory.tag': 'Write tags to cloud resources',
  'resource.operate': 'Run resource operations (refresh from the provider, re-evaluate)',
  'finops.sync': 'Run cost syncs',
  'finops.budget.manage': 'Create, change and delete budgets',
  'standards.evaluate': 'Run a compliance evaluation',
  'standards.manage': 'Author custom standards and change rules',
  'standards.exempt': 'Grant and revoke compliance exemptions',
  'remediation.request': 'Plan remediations and ask for them to run',
  'remediation.approve': 'Approve or reject remediations requested by someone else',
  'remediation.execute': 'Execute approved remediations and low-risk actions',
  'work.manage': 'Create, change and comment on work items',
  'docs.manage': 'Write workspace documents',
  'automation.manage': 'Create and change automation rules',
  'views.manage': 'Change or delete saved views created by others',
  'provider.manage': 'Add, change, pause and remove cloud organizations and credentials',
  'users.manage': 'Manage user accounts, roles and sessions',
  'audit.read': 'Read the audit log',
  'system.read': 'Read system status, jobs and platform internals',
  'system.manage': 'Retry or remove background jobs and run data-integrity repairs',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

/** Groups for the permission matrix (Users page). */
export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  { label: 'Estate', permissions: ['inventory.sync', 'inventory.tag', 'resource.operate'] },
  { label: 'Cost', permissions: ['finops.sync', 'finops.budget.manage'] },
  { label: 'Governance', permissions: ['standards.evaluate', 'standards.manage', 'standards.exempt'] },
  { label: 'Remediation', permissions: ['remediation.request', 'remediation.approve', 'remediation.execute'] },
  { label: 'Work & knowledge', permissions: ['work.manage', 'docs.manage', 'automation.manage', 'views.manage'] },
  { label: 'Platform', permissions: ['provider.manage', 'users.manage', 'audit.read', 'system.read', 'system.manage'] },
];

/** Built-in roles. `admin`, `operator` and `viewer` keep their original meaning. */
export const ROLE_DEFINITIONS = {
  admin: {
    label: 'Administrator',
    description: 'Everything, including accounts, credentials, the audit log and platform internals.',
    permissions: PERMISSION_KEYS,
  },
  operator: {
    label: 'Cloud operator',
    description: 'Runs the estate day to day: syncs, tags, cost, standards, remediation, work and docs.',
    permissions: [
      'inventory.sync',
      'inventory.tag',
      'resource.operate',
      'finops.sync',
      'finops.budget.manage',
      'standards.evaluate',
      'standards.manage',
      'standards.exempt',
      'remediation.request',
      'remediation.approve',
      'remediation.execute',
      'work.manage',
      'docs.manage',
      'automation.manage',
      'views.manage',
    ],
  },
  finops: {
    label: 'FinOps analyst',
    description: 'Owns cost: cost syncs, budgets and cost work items. Read-only elsewhere.',
    permissions: ['finops.sync', 'finops.budget.manage', 'work.manage', 'docs.manage'],
  },
  security: {
    label: 'Security analyst',
    description: 'Owns compliance: evaluations, rules, exemptions, requesting remediations, and the audit log.',
    permissions: [
      'standards.evaluate',
      'standards.manage',
      'standards.exempt',
      'remediation.request',
      'work.manage',
      'docs.manage',
      'audit.read',
    ],
  },
  viewer: {
    label: 'Read only',
    description: 'Sees the whole estate, cost, compliance, work and docs. Changes nothing.',
    permissions: [],
  },
} as const satisfies Record<string, { label: string; description: string; permissions: readonly Permission[] }>;

export type RoleKey = keyof typeof ROLE_DEFINITIONS;

/** Effective permissions of a set of roles (unknown role keys grant nothing). */
export function permissionsFor(roles: readonly string[]): Permission[] {
  const out = new Set<Permission>();
  for (const r of roles) {
    const def = (ROLE_DEFINITIONS as Record<string, { permissions: readonly Permission[] }>)[r];
    if (def) for (const p of def.permissions) out.add(p);
  }
  return PERMISSION_KEYS.filter((p) => out.has(p));
}

export function hasPermission(roles: readonly string[], permission: Permission): boolean {
  return permissionsFor(roles).includes(permission);
}
