import type { RuleCategory, RuleParamSpec, StandardSeverity } from '@cloudops/core';

/**
 * The rule library. Every rule knows what it checks and why, how to fix a
 * failure, which resource types it applies to, and its parameters. Evaluators
 * return `null` for "not applicable" — the resource is out of the rule's reach
 * or there is nothing to judge (e.g. Azure didn't report the property) — which
 * is neither a pass nor a fail and never lowers a score.
 *
 * Evaluators read the Azure Resource Graph `properties` the sync stores; every
 * property used here was checked against real inventory.
 */

// ── Evaluation inputs ──────────────────────────────────────────────

export interface EvalResource {
  id: string;
  /** Lower-cased ARM id. */
  externalId: string;
  name: string;
  /** Lower-cased resource type (`microsoft.web/sites`). */
  type: string;
  location: string | null;
  sku: string | null;
  owner: string | null;
  /** Azure + CloudOps-only tags, merged. */
  tags: Record<string, string>;
  lifecycleStage: string;
  inUse: boolean | null;
  retireBy: Date | null;
  costDaily: number | null;
  costMonthly: number | null;
  /** Real creation time when known, else first-seen. */
  createdAt: Date;
  properties: Record<string, unknown>;
  subscriptionId: string | null;
  subscriptionName: string | null;
  resourceGroupId: string | null;
  resourceGroupName: string | null;
}

export interface EvalContext {
  now: Date;
  /** Whether any cost has ever been synced (cost rules can't judge before that). */
  costSynced: boolean;
  /** Every active resource by lower-cased ARM id (for parent/child checks). */
  byExternalId: Map<string, EvalResource>;
  /** Web apps grouped by their App Service plan's lower-cased id. */
  sitesByPlan: Map<string, EvalResource[]>;
}

export type Verdict = { passed: boolean; detail?: string } | null;
export type Params = Record<string, unknown>;

export interface RuleTemplate {
  key: string;
  name: string;
  category: RuleCategory;
  severity: StandardSeverity;
  description: string;
  remediation: string;
  /** Human summary of the resources it applies to. */
  appliesTo: string;
  /** Lower-cased types it applies to; null = all resources. */
  types: string[] | null;
  params?: RuleParamSpec[];
  evaluate: (r: EvalResource, p: Params, ctx: EvalContext) => Verdict;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Dotted path into `properties` (case-sensitive, as ARM returns it). */
export function prop(r: EvalResource, path: string): unknown {
  let cur: unknown = r.properties;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const str = (v: unknown): string | null => (v == null ? null : String(v));
const lower = (v: unknown): string => String(v ?? '').toLowerCase();

export function tagValue(r: EvalResource, key: string): string | null {
  const k = Object.keys(r.tags).find((t) => t.toLowerCase() === key.toLowerCase());
  return k ? (r.tags[k] ?? null) : null;
}

export function listParam(p: Params, key: string): string[] {
  const v = p[key];
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return arr.map((s) => String(s).trim()).filter(Boolean);
}
const strParam = (p: Params, key: string): string => String(p[key] ?? '').trim();
const numParam = (p: Params, key: string, fallback: number): number => {
  const n = Number(p[key]);
  return Number.isFinite(n) ? n : fallback;
};

/** env / environment tag value (lower-cased), if any. */
export function environmentOf(r: EvalResource): string | null {
  const v = tagValue(r, 'environment') ?? tagValue(r, 'env');
  return v ? v.toLowerCase() : null;
}
const PROD = /^(prod|production|prd|live)([-_ ].*)?$/;
export const isProduction = (r: EvalResource): boolean => PROD.test(environmentOf(r) ?? '');

/** Reliability rules default to production only; resources without an env tag can't be judged. */
function productionGate(r: EvalResource, p: Params): boolean {
  return p.productionOnly === false || isProduction(r);
}
const PRODUCTION_ONLY: RuleParamSpec = {
  key: 'productionOnly',
  label: 'Only production resources',
  kind: 'boolean',
  default: true,
  help: 'Judge only resources tagged environment=prod/production. Untagged resources are skipped.',
};

/** Name of an ARM id's last segment (for "billed through X" details). */
const nameOf = (id: string) => id.split('/').pop() ?? id;

/** The ARM parent of a child resource id (`…/servers/a/databases/b` → `…/servers/a`). */
export function parentId(externalId: string): string | null {
  const m = /^(\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/[^/]+\/[^/]+\/[^/]+)\/[^/]+\/[^/]+/.exec(externalId);
  return m ? m[1]! : null;
}

// ── Cost visibility: resources with a fixed price ─────────────────────

/**
 * Types Azure bills for every hour they exist (a provisioned price), so "no cost
 * data" means the cost data is missing — not that the resource was idle.
 * Pay-per-use services (functions, AI services, runbooks, monitoring, storage
 * transactions…) legitimately cost nothing when unused and are not judged; web
 * apps are billed through their App Service plan, which is judged instead.
 */
const ALWAYS_BILLED = new Set([
  'microsoft.compute/virtualmachines',
  'microsoft.compute/virtualmachinescalesets',
  'microsoft.compute/disks',
  'microsoft.compute/snapshots',
  'microsoft.web/serverfarms',
  'microsoft.web/staticsites',
  'microsoft.sql/servers/databases',
  'microsoft.sql/servers/elasticpools',
  'microsoft.sql/managedinstances',
  'microsoft.dbforpostgresql/flexibleservers',
  'microsoft.dbformysql/flexibleservers',
  'microsoft.cache/redis',
  'microsoft.cache/redisenterprise',
  'microsoft.network/publicipaddresses',
  'microsoft.network/applicationgateways',
  'microsoft.network/virtualnetworkgateways',
  'microsoft.network/azurefirewalls',
  'microsoft.network/bastionhosts',
  'microsoft.network/natgateways',
  'microsoft.network/loadbalancers',
  'microsoft.network/privateendpoints',
  'microsoft.network/dnszones',
  'microsoft.network/privatednszones',
  'microsoft.cdn/profiles',
  'microsoft.containerregistry/registries',
  'microsoft.containerservice/managedclusters',
  'microsoft.apimanagement/service',
  'microsoft.search/searchservices',
  'microsoft.appconfiguration/configurationstores',
  'microsoft.servicebus/namespaces',
  'microsoft.eventhub/namespaces',
  'microsoft.signalrservice/signalr',
  'microsoft.kusto/clusters',
]);

/** A fixed-price type in a state or tier that isn't billed (deallocated, stopped, free/consumption tier). */
function notBilledNow(r: EvalResource): boolean {
  const sku = (r.sku ?? '').toLowerCase();
  switch (r.type) {
    case 'microsoft.compute/virtualmachines':
      return str(prop(r, 'extended.instanceView.powerState.code')) === 'PowerState/deallocated';
    case 'microsoft.dbforpostgresql/flexibleservers':
    case 'microsoft.dbformysql/flexibleservers':
      return lower(prop(r, 'state')) === 'stopped';
    case 'microsoft.web/serverfarms':
      return isConsumptionPlan(r) || /^f1|^free/.test(sku);
    case 'microsoft.web/staticsites':
      return sku === 'free' || sku === '';
    case 'microsoft.network/bastionhosts':
      return sku === 'developer';
    case 'microsoft.network/publicipaddresses':
      return lower(prop(r, 'publicIPAllocationMethod')) === 'dynamic' && sku !== 'standard';
    case 'microsoft.network/loadbalancers':
      return sku === 'basic';
    case 'microsoft.containerservice/managedclusters':
      return sku === 'free' || lower(prop(r, 'sku.tier')) === 'free';
    case 'microsoft.apimanagement/service':
      return sku.startsWith('consumption');
    case 'microsoft.search/searchservices':
      return sku === 'free';
    case 'microsoft.appconfiguration/configurationstores':
      return sku === 'free';
    case 'microsoft.servicebus/namespaces':
      return sku === 'basic';
    default:
      return false;
  }
}

/** Where Azure books a fixed-price resource's cost when it isn't on the resource itself. */
function billingParents(r: EvalResource): string[] {
  const out: string[] = [];
  const pool = str(prop(r, 'elasticPoolId'));
  if (pool) out.push(pool.toLowerCase()); // a database in an elastic pool is billed on the pool
  const parent = parentId(r.externalId);
  if (parent) out.push(parent);
  return out;
}

const hasCost = (r: EvalResource | undefined) => Boolean(r && (r.costMonthly ?? 0) > 0);

// ── Naming: Cloud Adoption Framework abbreviations ─────────────────

export const CAF_PREFIXES: Record<string, string[]> = {
  'microsoft.compute/virtualmachines': ['vm'],
  'microsoft.compute/virtualmachinescalesets': ['vmss'],
  'microsoft.compute/disks': ['disk', 'osdisk'],
  'microsoft.compute/availabilitysets': ['avail'],
  'microsoft.network/virtualnetworks': ['vnet'],
  'microsoft.network/networksecuritygroups': ['nsg'],
  'microsoft.network/networkinterfaces': ['nic'],
  'microsoft.network/publicipaddresses': ['pip'],
  'microsoft.network/loadbalancers': ['lbi', 'lbe', 'lb'],
  'microsoft.network/applicationgateways': ['agw'],
  'microsoft.network/bastionhosts': ['bas'],
  'microsoft.network/routetables': ['rt'],
  'microsoft.network/privateendpoints': ['pep', 'pe'],
  'microsoft.network/azurefirewalls': ['afw'],
  'microsoft.storage/storageaccounts': ['st'],
  'microsoft.keyvault/vaults': ['kv'],
  'microsoft.web/serverfarms': ['asp', 'plan'],
  'microsoft.web/sites': ['app', 'func'],
  'microsoft.web/staticsites': ['stapp'],
  'microsoft.sql/servers': ['sql'],
  'microsoft.sql/servers/databases': ['sqldb'],
  'microsoft.dbforpostgresql/flexibleservers': ['psql'],
  'microsoft.dbformysql/flexibleservers': ['mysql'],
  'microsoft.documentdb/databaseaccounts': ['cosmos'],
  'microsoft.cache/redis': ['redis'],
  'microsoft.containerregistry/registries': ['cr'],
  'microsoft.containerservice/managedclusters': ['aks'],
  'microsoft.app/containerapps': ['ca'],
  'microsoft.app/managedenvironments': ['cae'],
  'microsoft.operationalinsights/workspaces': ['log'],
  'microsoft.insights/components': ['appi'],
  'microsoft.insights/actiongroups': ['ag'],
  'microsoft.servicebus/namespaces': ['sbns'],
  'microsoft.eventhub/namespaces': ['evhns'],
  'microsoft.logic/workflows': ['logic'],
  'microsoft.cognitiveservices/accounts': ['cog', 'ais', 'oai', 'aoai'],
  'microsoft.machinelearningservices/workspaces': ['mlw'],
  'microsoft.managedidentity/userassignedidentities': ['id'],
  'microsoft.recoveryservices/vaults': ['rsv'],
  'microsoft.dataprotection/backupvaults': ['bvault'],
  'microsoft.automation/automationaccounts': ['aa'],
  'microsoft.cdn/profiles': ['afd', 'cdnp'],
  'microsoft.apimanagement/service': ['apim'],
  'microsoft.datafactory/factories': ['adf'],
  'microsoft.search/searchservices': ['srch'],
};
/** Types whose names can't contain dashes — the prefix is glued on. */
const NO_DASH = new Set(['microsoft.storage/storageaccounts', 'microsoft.containerregistry/registries']);

// ── Shared type groups ─────────────────────────────────────────────

const PAAS_DATA = [
  'microsoft.storage/storageaccounts',
  'microsoft.keyvault/vaults',
  'microsoft.sql/servers',
  'microsoft.dbforpostgresql/flexibleservers',
  'microsoft.dbformysql/flexibleservers',
  'microsoft.cache/redis',
  'microsoft.cognitiveservices/accounts',
  'microsoft.containerregistry/registries',
  'microsoft.documentdb/databaseaccounts',
  'microsoft.servicebus/namespaces',
  'microsoft.eventhub/namespaces',
  'microsoft.search/searchservices',
  'microsoft.appconfiguration/configurationstores',
];
const IDENTITY_CAPABLE = [
  'microsoft.web/sites',
  'microsoft.app/containerapps',
  'microsoft.logic/workflows',
  'microsoft.compute/virtualmachines',
  'microsoft.datafactory/factories',
  'microsoft.apimanagement/service',
  'microsoft.containerservice/managedclusters',
];
/** App Service plans on consumption billing (no fixed instances). */
const isConsumptionPlan = (r: EvalResource) => /^(y1|fc1|dynamic|flex)/i.test(r.sku ?? '') || lower(prop(r, 'sku.tier')) === 'dynamic';

// ── The library ────────────────────────────────────────────────────

export const RULE_LIBRARY: RuleTemplate[] = [
  // ─── Tagging & ownership ───
  {
    key: 'owner-present',
    name: 'Has an owner',
    category: 'tagging',
    severity: 'high',
    description: 'Every resource needs an accountable owner, read from the owner tag. Unowned resources are the ones nobody cleans up, patches or pays attention to.',
    remediation: 'Add the owner tag (default `Owner`) with a person or team. To tag a whole resource group at once, use Resource groups → Apply tags.',
    appliesTo: 'All resources',
    types: null,
    evaluate: (r) => ({ passed: Boolean(r.owner), detail: r.owner ? undefined : 'no owner tag' }),
  },
  {
    key: 'has-tags',
    name: 'Has at least one tag',
    category: 'tagging',
    severity: 'medium',
    description: 'Untagged resources can’t be attributed to a team, environment or cost centre.',
    remediation: 'Add tags such as environment, owner and cost-center (in Azure, or in the resource’s Tags panel here).',
    appliesTo: 'All resources',
    types: null,
    evaluate: (r) => ({ passed: Object.keys(r.tags).length > 0, detail: 'untagged' }),
  },
  {
    key: 'env-tag',
    name: 'Has an environment tag',
    category: 'tagging',
    severity: 'medium',
    description: 'An environment tag (env / environment) separates production from dev/test — and lets production-only rules (reliability) judge the resource.',
    remediation: 'Add `environment` = prod, staging, dev or test.',
    appliesTo: 'All resources',
    types: null,
    evaluate: (r) => ({ passed: environmentOf(r) !== null, detail: 'no environment tag' }),
  },
  {
    key: 'required-tags',
    name: 'Has the required tags',
    category: 'tagging',
    severity: 'medium',
    description: 'Every resource carries your organisation’s mandatory tags (for chargeback, ownership, data classification…).',
    remediation: 'Add the missing tags listed in the finding.',
    appliesTo: 'All resources',
    types: null,
    params: [
      { key: 'tags', label: 'Required tag keys', kind: 'stringList', required: true, default: ['environment', 'owner', 'cost-center'], placeholder: 'environment, owner, cost-center' },
    ],
    evaluate: (r, p) => {
      const required = listParam(p, 'tags');
      if (required.length === 0) return null;
      const missing = required.filter((k) => tagValue(r, k) == null);
      return { passed: missing.length === 0, detail: `missing: ${missing.join(', ')}` };
    },
  },
  {
    key: 'tag-allowed-values',
    name: 'Tag value is one of the allowed values',
    category: 'tagging',
    severity: 'low',
    description: 'A tag uses a controlled vocabulary (e.g. environment ∈ prod, staging, dev) so reports group cleanly.',
    remediation: 'Change the tag to one of the allowed values.',
    appliesTo: 'Resources carrying the tag',
    types: null,
    params: [
      { key: 'tagKey', label: 'Tag key', kind: 'tagKey', required: true, placeholder: 'environment' },
      { key: 'values', label: 'Allowed values', kind: 'stringList', required: true, placeholder: 'prod, staging, dev, test' },
    ],
    evaluate: (r, p) => {
      const key = strParam(p, 'tagKey');
      const allowed = listParam(p, 'values').map((v) => v.toLowerCase());
      const v = key ? tagValue(r, key) : null;
      if (!key || allowed.length === 0 || v == null) return null;
      return { passed: allowed.includes(v.toLowerCase()), detail: `${key} = "${v}"` };
    },
  },
  {
    key: 'tag-value-pattern',
    name: 'Tag value matches a pattern',
    category: 'tagging',
    severity: 'low',
    description: 'A tag’s value follows a format (e.g. cost-center is `CC-` + 4 digits, owner is an email).',
    remediation: 'Correct the tag value to the expected format.',
    appliesTo: 'Resources carrying the tag',
    types: null,
    params: [
      { key: 'tagKey', label: 'Tag key', kind: 'tagKey', required: true, placeholder: 'cost-center' },
      { key: 'pattern', label: 'Regex', kind: 'regex', required: true, placeholder: '^CC-\\d{4}$' },
    ],
    evaluate: (r, p) => {
      const key = strParam(p, 'tagKey');
      const v = key ? tagValue(r, key) : null;
      const re = safeRegex(strParam(p, 'pattern'));
      if (!key || !re || v == null) return null;
      return { passed: re.test(v), detail: `${key} = "${v}"` };
    },
  },

  // ─── Naming ───
  {
    key: 'no-spaces',
    name: 'Name has no whitespace',
    category: 'naming',
    severity: 'low',
    description: 'Names with spaces break scripts, URLs and CLI usage.',
    remediation: 'Most Azure resources can’t be renamed — recreate with a clean name, or exempt it.',
    appliesTo: 'All resources',
    types: null,
    evaluate: (r) => ({ passed: !/\s/.test(r.name), detail: 'name contains spaces' }),
  },
  {
    key: 'valid-length',
    name: 'Name is not too long',
    category: 'naming',
    severity: 'low',
    description: 'Very long names get truncated in portals and reports.',
    remediation: 'Use a shorter name for new resources (existing ones usually can’t be renamed).',
    appliesTo: 'All resources',
    types: null,
    params: [{ key: 'maxLength', label: 'Maximum length', kind: 'number', default: 80 }],
    evaluate: (r, p) => {
      const max = numParam(p, 'maxLength', 80);
      return { passed: r.name.length <= max, detail: `${r.name.length} characters (max ${max})` };
    },
  },
  {
    key: 'caf-prefix',
    name: 'Name starts with the CAF abbreviation for its type',
    category: 'naming',
    severity: 'low',
    description: 'The Cloud Adoption Framework’s abbreviations (vm-, st, kv-, app-, asp-, vnet-, psql-…) make a resource’s kind obvious from its name.',
    remediation: 'Name new resources `<abbreviation>-<workload>-<env>-<region>-<nnn>` (storage and registries without dashes).',
    appliesTo: 'Types with a CAF abbreviation (~45 common types)',
    types: Object.keys(CAF_PREFIXES),
    evaluate: (r) => {
      const prefixes = CAF_PREFIXES[r.type];
      if (!prefixes?.length) return null;
      const n = r.name.toLowerCase();
      const ok = prefixes.some((pre) => (NO_DASH.has(r.type) ? n.startsWith(pre) : n.startsWith(`${pre}-`)));
      return { passed: ok, detail: `expected prefix ${prefixes.map((x) => (NO_DASH.has(r.type) ? x : `${x}-`)).join(' or ')}` };
    },
  },
  {
    key: 'lowercase-name',
    name: 'Name is lower-case',
    category: 'naming',
    severity: 'low',
    description: 'Consistent lower-case names avoid case-sensitivity surprises across tools.',
    remediation: 'Use lower-case names for new resources.',
    appliesTo: 'All resources',
    types: null,
    evaluate: (r) => ({ passed: r.name === r.name.toLowerCase(), detail: 'contains upper-case letters' }),
  },
  {
    key: 'name-pattern',
    name: 'Name matches a pattern',
    category: 'naming',
    severity: 'low',
    description: 'Names follow your own convention (combine with a scope to target specific types).',
    remediation: 'Use the naming convention for new resources.',
    appliesTo: 'In-scope resources',
    types: null,
    params: [{ key: 'pattern', label: 'Regex', kind: 'regex', required: true, placeholder: '^[a-z]+-[a-z0-9]+-(prod|dev)-' }],
    evaluate: (r, p) => {
      const re = safeRegex(strParam(p, 'pattern'));
      if (!re) return null;
      return { passed: re.test(r.name), detail: `"${r.name}" doesn’t match` };
    },
  },

  // ─── Security ───
  {
    key: 'https-only',
    name: 'Web app accepts HTTPS only',
    category: 'security',
    severity: 'high',
    description: 'With HTTPS-only off, the app also answers over plain HTTP — credentials and data can travel unencrypted.',
    remediation: 'App Service → Settings → Configuration → General → HTTPS Only = On (or `az webapp update --https-only true`).',
    appliesTo: 'Web apps and function apps',
    types: ['microsoft.web/sites', 'microsoft.web/sites/slots'],
    evaluate: (r) => {
      const v = prop(r, 'httpsOnly');
      if (v == null) return null;
      return { passed: v === true, detail: 'HTTPS-only is off' };
    },
  },
  {
    key: 'storage-secure-transfer',
    name: 'Storage requires secure transfer',
    category: 'security',
    severity: 'high',
    description: 'Secure transfer rejects plain-HTTP (and unencrypted SMB) requests to the storage account.',
    remediation: 'Storage account → Configuration → Secure transfer required = Enabled.',
    appliesTo: 'Storage accounts',
    types: ['microsoft.storage/storageaccounts'],
    evaluate: (r) => {
      const v = prop(r, 'supportsHttpsTrafficOnly');
      if (v == null) return null;
      return { passed: v === true, detail: 'plain HTTP allowed' };
    },
  },
  {
    key: 'min-tls-1-2',
    name: 'Minimum TLS version is 1.2',
    category: 'security',
    severity: 'high',
    description: 'TLS 1.0/1.1 are deprecated and vulnerable; clients should be forced onto TLS 1.2 or later.',
    remediation: 'Set the minimum TLS version to 1.2 (Storage: Configuration; SQL server: Networking → Connectivity; Redis: Advanced settings).',
    appliesTo: 'Storage accounts, SQL servers, Redis caches',
    types: ['microsoft.storage/storageaccounts', 'microsoft.sql/servers', 'microsoft.cache/redis'],
    evaluate: (r) => {
      const raw =
        r.type === 'microsoft.storage/storageaccounts'
          ? prop(r, 'minimumTlsVersion') ?? 'TLS1_0' // unset on old accounts = TLS 1.0 allowed
          : r.type === 'microsoft.sql/servers'
            ? prop(r, 'minimalTlsVersion')
            : prop(r, 'minimumTlsVersion');
      if (raw == null || raw === 'None') return raw === 'None' ? { passed: false, detail: 'no minimum TLS version' } : null;
      const v = Number(String(raw).replace(/^TLS/i, '').replace('_', '.'));
      return { passed: Number.isFinite(v) && v >= 1.2, detail: `minimum TLS is ${raw}` };
    },
  },
  {
    key: 'storage-no-public-blob',
    name: 'Blob public access is disabled',
    category: 'security',
    severity: 'high',
    description: 'When allowed, any container can be made anonymously readable — a common source of data leaks.',
    remediation: 'Storage account → Configuration → Allow Blob anonymous access = Disabled.',
    appliesTo: 'Storage accounts',
    types: ['microsoft.storage/storageaccounts'],
    evaluate: (r) => {
      const v = prop(r, 'allowBlobPublicAccess');
      if (v == null) return null;
      return { passed: v === false, detail: 'anonymous blob access allowed' };
    },
  },
  {
    key: 'public-network-restricted',
    name: 'Public network access is restricted',
    category: 'security',
    severity: 'medium',
    description: 'Data services reachable from the whole internet rely on credentials alone. Disable public access (use private endpoints) or default-deny the firewall.',
    remediation: 'Networking → Public network access = Disabled (with a private endpoint), or Enabled from selected networks only.',
    appliesTo: 'Storage, Key Vault, SQL, PostgreSQL, MySQL, Redis, AI services, container registries, Cosmos DB, Service Bus, Event Hubs, AI Search, App Configuration',
    types: PAAS_DATA,
    evaluate: (r) => {
      const pna = lower(prop(r, 'publicNetworkAccess') ?? prop(r, 'network.publicNetworkAccess'));
      const acl = lower(prop(r, 'networkAcls.defaultAction'));
      if (!pna && !acl) return null;
      if (pna === 'disabled') return { passed: true };
      if (acl === 'deny') return { passed: true };
      return { passed: false, detail: acl === 'allow' ? 'public access enabled, firewall allows all networks' : 'public network access enabled' };
    },
  },
  {
    key: 'keyvault-soft-delete',
    name: 'Key Vault soft delete is on',
    category: 'security',
    severity: 'high',
    description: 'Soft delete keeps deleted secrets, keys and certificates recoverable.',
    remediation: 'Soft delete is mandatory for new vaults; for old vaults: `az keyvault update --enable-soft-delete true`.',
    appliesTo: 'Key vaults',
    types: ['microsoft.keyvault/vaults'],
    evaluate: (r) => ({ passed: prop(r, 'enableSoftDelete') !== false, detail: 'soft delete disabled' }),
  },
  {
    key: 'keyvault-purge-protection',
    name: 'Key Vault purge protection is on',
    category: 'security',
    severity: 'medium',
    description: 'Without purge protection, a deleted vault or secret can be purged immediately — by mistake or by an attacker.',
    remediation: 'Key vault → Properties → Purge protection = Enable (irreversible).',
    appliesTo: 'Key vaults',
    types: ['microsoft.keyvault/vaults'],
    evaluate: (r) => ({ passed: prop(r, 'enablePurgeProtection') === true, detail: 'purge protection off' }),
  },
  {
    key: 'keyvault-rbac',
    name: 'Key Vault uses Azure RBAC',
    category: 'security',
    severity: 'low',
    description: 'RBAC authorisation gives central, auditable, least-privilege access instead of per-vault access policies.',
    remediation: 'Key vault → Access configuration → Azure role-based access control (migrate access policies first).',
    appliesTo: 'Key vaults',
    types: ['microsoft.keyvault/vaults'],
    evaluate: (r) => ({ passed: prop(r, 'enableRbacAuthorization') === true, detail: 'uses access policies' }),
  },
  {
    key: 'managed-identity',
    name: 'Uses a managed identity',
    category: 'security',
    severity: 'low',
    description: 'A managed identity lets the workload reach other Azure services without stored credentials.',
    remediation: 'Identity → System assigned = On (or attach a user-assigned identity), then replace connection strings/keys with role assignments.',
    appliesTo: 'Web apps, container apps, logic apps, VMs, data factories, API Management, AKS',
    types: IDENTITY_CAPABLE,
    evaluate: (r) => {
      const t = lower(prop(r, 'identityType'));
      return { passed: t !== '' && t !== 'none', detail: 'no managed identity' };
    },
  },
  {
    key: 'acr-admin-disabled',
    name: 'Container registry admin user is disabled',
    category: 'security',
    severity: 'medium',
    description: 'The admin user is a shared, full-access credential. Use Entra identities and role assignments instead.',
    remediation: 'Container registry → Access keys → Admin user = Disabled.',
    appliesTo: 'Container registries',
    types: ['microsoft.containerregistry/registries'],
    evaluate: (r) => {
      const v = prop(r, 'adminUserEnabled');
      if (v == null) return null;
      return { passed: v === false, detail: 'admin user enabled' };
    },
  },
  {
    key: 'redis-tls-only',
    name: 'Redis non-TLS port is closed',
    category: 'security',
    severity: 'high',
    description: 'The non-SSL port (6379) sends data and the access key in clear text.',
    remediation: 'Redis → Advanced settings → Allow access only via SSL = Yes.',
    appliesTo: 'Redis caches',
    types: ['microsoft.cache/redis'],
    evaluate: (r) => ({ passed: prop(r, 'enableNonSslPort') !== true, detail: 'non-TLS port 6379 open' }),
  },
  {
    key: 'local-auth-disabled',
    name: 'Key-based authentication is disabled',
    category: 'security',
    severity: 'low',
    description: 'Access keys can’t be scoped or audited per user. Entra ID authentication only is the stronger default.',
    remediation: 'Disable local/key auth (AI services: disableLocalAuth; Storage: Allow storage account key access = Disabled; Redis: disable access keys).',
    appliesTo: 'AI services, storage accounts, Redis caches',
    types: ['microsoft.cognitiveservices/accounts', 'microsoft.storage/storageaccounts', 'microsoft.cache/redis'],
    evaluate: (r) => {
      if (r.type === 'microsoft.storage/storageaccounts') {
        const v = prop(r, 'allowSharedKeyAccess');
        return v == null ? null : { passed: v === false, detail: 'account keys allowed' };
      }
      const v = r.type === 'microsoft.cache/redis' ? prop(r, 'disableAccessKeyAuthentication') : prop(r, 'disableLocalAuth');
      return v == null ? null : { passed: v === true, detail: 'key-based auth allowed' };
    },
  },
  {
    key: 'vm-no-public-ip',
    name: 'VM has no public IP',
    category: 'security',
    severity: 'medium',
    description: 'A public IP on a VM’s network interface exposes it directly to the internet. Reach VMs through Bastion, a VPN or a load balancer instead.',
    remediation: 'Dissociate the public IP from the NIC’s IP configuration; use Azure Bastion for admin access.',
    appliesTo: 'Virtual machines',
    types: ['microsoft.compute/virtualmachines'],
    evaluate: (r, _p, ctx) => {
      const nics = (prop(r, 'networkProfile.networkInterfaces') as { id?: string }[] | undefined) ?? [];
      if (!Array.isArray(nics) || nics.length === 0) return null;
      let known = false;
      for (const n of nics) {
        const nic = n.id ? ctx.byExternalId.get(n.id.toLowerCase()) : undefined;
        if (!nic) continue;
        known = true;
        const configs = (prop(nic, 'ipConfigurations') as { properties?: { publicIPAddress?: { id?: string } } }[] | undefined) ?? [];
        const pip = configs.find((c) => c?.properties?.publicIPAddress?.id);
        if (pip) return { passed: false, detail: `public IP ${nameOf(pip.properties!.publicIPAddress!.id!)} on ${nic.name}` };
      }
      return known ? { passed: true } : null;
    },
  },

  // ─── Cost optimization ───
  {
    key: 'cost-visibility',
    name: 'Fixed-price resource has cost data',
    category: 'governance',
    severity: 'low',
    description:
      'Resources with a fixed price — VMs, disks, dedicated App Service plans, databases, gateways, registries, static IPs — are billed every hour they exist, so no cost after a cost sync means cost data is missing. Pay-per-use services (functions, AI services, runbooks, monitoring) cost nothing when idle and web apps are billed through their plan, so neither is judged.',
    remediation: 'Run a FinOps cost sync. If it still has no cost, give the service principal Cost Management Reader on that subscription and check the subscription is included in the cost sync.',
    appliesTo: 'Fixed-price resources (VMs, disks, App Service plans, databases, gateways, registries, IPs…)',
    types: [...ALWAYS_BILLED],
    evaluate: (r, _p, ctx) => {
      if (!ctx.costSynced) return null; // nothing to judge before the first cost sync
      if (notBilledNow(r)) return null;
      if (ctx.now.getTime() - r.createdAt.getTime() < 3 * 86_400_000) return null; // cost lags ~1-2 days
      if (hasCost(r)) return { passed: true };
      for (const pid of billingParents(r)) {
        const parent = ctx.byExternalId.get(pid);
        if (hasCost(parent)) return { passed: true, detail: `billed through ${parent!.name}` };
      }
      return { passed: false, detail: 'billed by the hour, but no cost reported' };
    },
  },
  {
    key: 'unattached-disk',
    name: 'No unattached managed disks',
    category: 'cost',
    severity: 'high',
    description: 'A disk not attached to any VM is still billed for its full provisioned size — usually left over after deleting a VM.',
    remediation: 'Snapshot it if you might need the data, then delete the disk.',
    appliesTo: 'Managed disks',
    types: ['microsoft.compute/disks'],
    evaluate: (r) => {
      const state = str(prop(r, 'diskState'));
      if (!state) return null;
      return { passed: state !== 'Unattached', detail: 'disk is unattached' };
    },
  },
  {
    key: 'unassociated-public-ip',
    name: 'No unused public IPs',
    category: 'cost',
    severity: 'medium',
    description: 'Static public IPs are billed even when attached to nothing.',
    remediation: 'Delete the public IP, or attach it to the resource that needs it.',
    appliesTo: 'Public IP addresses',
    types: ['microsoft.network/publicipaddresses'],
    evaluate: (r) => {
      const attached = prop(r, 'ipConfiguration') != null || prop(r, 'natGateway') != null;
      return { passed: attached, detail: 'not associated with anything' };
    },
  },
  {
    key: 'orphaned-nic',
    name: 'No orphaned network interfaces',
    category: 'cost',
    severity: 'low',
    description: 'A NIC attached to no VM or private endpoint is clutter left over from a deleted VM (and may still hold a public IP).',
    remediation: 'Delete the network interface.',
    appliesTo: 'Network interfaces',
    types: ['microsoft.network/networkinterfaces'],
    evaluate: (r) => {
      const used = prop(r, 'virtualMachine') != null || prop(r, 'privateEndpoint') != null || prop(r, 'privateLinkService') != null;
      return { passed: used, detail: 'attached to nothing' };
    },
  },
  {
    key: 'vm-stopped-not-deallocated',
    name: 'Stopped VMs are deallocated',
    category: 'cost',
    severity: 'high',
    description: 'A VM stopped from inside the OS keeps its compute reserved — and billed. Only “Stopped (deallocated)” stops the charge.',
    remediation: 'Stop the VM from the portal/CLI (`az vm deallocate`), not from inside the guest OS.',
    appliesTo: 'Virtual machines',
    types: ['microsoft.compute/virtualmachines'],
    evaluate: (r) => {
      const code = str(prop(r, 'extended.instanceView.powerState.code'));
      if (!code) return null;
      return { passed: code !== 'PowerState/stopped', detail: 'stopped but still allocated (billed)' };
    },
  },
  {
    key: 'empty-app-service-plan',
    name: 'App Service plan hosts at least one app',
    category: 'cost',
    severity: 'high',
    description: 'A dedicated App Service plan is billed per instance whether or not any app runs on it.',
    remediation: 'Delete the empty plan, or move an app onto it.',
    appliesTo: 'App Service plans (dedicated)',
    types: ['microsoft.web/serverfarms'],
    evaluate: (r) => {
      if (isConsumptionPlan(r)) return null;
      const n = Number(prop(r, 'numberOfSites'));
      if (!Number.isFinite(n)) return null;
      return { passed: n > 0, detail: 'no apps on this plan' };
    },
  },
  {
    key: 'plan-apps-all-stopped',
    name: 'App Service plan isn’t running only stopped apps',
    category: 'cost',
    severity: 'medium',
    description: 'Stopping apps doesn’t stop the plan’s billing. A plan whose apps are all stopped is paying for nothing.',
    remediation: 'Delete the stopped apps and the plan, or scale the plan down to the Free/Basic tier.',
    appliesTo: 'App Service plans (dedicated)',
    types: ['microsoft.web/serverfarms'],
    evaluate: (r, _p, ctx) => {
      if (isConsumptionPlan(r)) return null;
      const sites = ctx.sitesByPlan.get(r.externalId) ?? [];
      if (sites.length === 0) return null;
      const running = sites.filter((s) => lower(prop(s, 'state')) !== 'stopped');
      return { passed: running.length > 0, detail: `all ${sites.length} app(s) stopped` };
    },
  },
  {
    key: 'max-monthly-cost',
    name: 'Monthly cost is under a limit',
    category: 'cost',
    severity: 'medium',
    description: 'Flags resources whose trailing-30-day cost exceeds a threshold — pair with a scope for per-type limits.',
    remediation: 'Review the resource’s size/SKU and usage on its Cost tab.',
    appliesTo: 'Resources with cost data',
    types: null,
    params: [{ key: 'amount', label: 'Monthly limit (reporting currency)', kind: 'number', required: true, default: 10000 }],
    evaluate: (r, p) => {
      if (r.costMonthly == null) return null;
      const limit = numParam(p, 'amount', 10000);
      return { passed: r.costMonthly <= limit, detail: `${Math.round(r.costMonthly)} over the ${limit} limit` };
    },
  },
  {
    key: 'nonprod-no-premium-sku',
    name: 'Non-production doesn’t use premium SKUs',
    category: 'cost',
    severity: 'low',
    description: 'Dev/test resources rarely need premium tiers.',
    remediation: 'Scale the resource down to a standard/basic tier.',
    appliesTo: 'Resources tagged as non-production',
    types: null,
    params: [
      { key: 'nonProdValues', label: 'Non-production environment values', kind: 'stringList', default: ['dev', 'test', 'qa', 'staging', 'sandbox'] },
      { key: 'premiumPattern', label: 'Premium SKU regex', kind: 'regex', default: '(^P\\d|premium|^I\\d|business)' },
    ],
    evaluate: (r, p) => {
      const env = environmentOf(r);
      const nonProd = listParam(p, 'nonProdValues').map((v) => v.toLowerCase());
      if (!env || !nonProd.includes(env) || !r.sku) return null;
      const re = safeRegex(strParam(p, 'premiumPattern') || '(^P\\d|premium)', 'i');
      if (!re) return null;
      return { passed: !re.test(r.sku), detail: `${env} resource on ${r.sku}` };
    },
  },

  // ─── Reliability ───
  {
    key: 'postgres-ha',
    name: 'PostgreSQL has high availability',
    category: 'reliability',
    severity: 'medium',
    description: 'Zone-redundant HA keeps a standby server in another zone and fails over automatically.',
    remediation: 'PostgreSQL flexible server → High availability → Zone redundant.',
    appliesTo: 'PostgreSQL flexible servers (production)',
    types: ['microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbformysql/flexibleservers'],
    params: [PRODUCTION_ONLY],
    evaluate: (r, p) => {
      if (!productionGate(r, p)) return null;
      const mode = str(prop(r, 'highAvailability.mode'));
      if (!mode) return null;
      return { passed: mode !== 'Disabled', detail: 'high availability disabled' };
    },
  },
  {
    key: 'db-geo-backup',
    name: 'Database backups are geo-redundant',
    category: 'reliability',
    severity: 'low',
    description: 'Geo-redundant backup lets you restore in another region after a regional outage.',
    remediation: 'Enable geo-redundant backup (set at server creation for PostgreSQL/MySQL flexible server).',
    appliesTo: 'PostgreSQL / MySQL flexible servers (production)',
    types: ['microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbformysql/flexibleservers'],
    params: [PRODUCTION_ONLY],
    evaluate: (r, p) => {
      if (!productionGate(r, p)) return null;
      const v = str(prop(r, 'backup.geoRedundantBackup'));
      if (!v) return null;
      return { passed: v === 'Enabled', detail: 'backups are locally redundant only' };
    },
  },
  {
    key: 'storage-redundancy',
    name: 'Storage is zone- or geo-redundant',
    category: 'reliability',
    severity: 'low',
    description: 'LRS keeps all copies in one datacenter; ZRS/GRS survive a zone or region failure.',
    remediation: 'Storage account → Redundancy → ZRS, GRS or GZRS.',
    appliesTo: 'Storage accounts (production)',
    types: ['microsoft.storage/storageaccounts'],
    params: [PRODUCTION_ONLY],
    evaluate: (r, p) => {
      if (!productionGate(r, p) || !r.sku) return null;
      return { passed: !/_LRS$/i.test(r.sku), detail: `${r.sku} (single datacenter)` };
    },
  },
  {
    key: 'app-plan-multi-instance',
    name: 'App Service plan runs 2+ instances',
    category: 'reliability',
    severity: 'low',
    description: 'A single instance is a single point of failure — platform maintenance restarts it.',
    remediation: 'Scale out the plan to at least 2 instances (and enable zone redundancy on Premium v3).',
    appliesTo: 'App Service plans, dedicated (production)',
    types: ['microsoft.web/serverfarms'],
    params: [PRODUCTION_ONLY],
    evaluate: (r, p) => {
      if (!productionGate(r, p) || isConsumptionPlan(r)) return null;
      const n = Number(prop(r, 'currentNumberOfWorkers') ?? prop(r, 'numberOfWorkers'));
      if (!Number.isFinite(n) || n === 0) return null;
      return { passed: n >= 2, detail: `${n} instance` };
    },
  },

  // ─── Governance & lifecycle ───
  {
    key: 'has-location',
    name: 'Has a region',
    category: 'governance',
    severity: 'low',
    description: 'Resources without a region can’t be placed for data-residency or latency reviews.',
    remediation: 'Usually a provider quirk; confirm the resource’s region in the portal.',
    appliesTo: 'All resources',
    types: null,
    evaluate: (r) => ({ passed: Boolean(r.location), detail: 'no region' }),
  },
  {
    key: 'allowed-locations',
    name: 'Deployed in an allowed region',
    category: 'governance',
    severity: 'medium',
    description: 'Keeps workloads inside approved regions (data residency, latency, pricing). `global` resources are always allowed.',
    remediation: 'Move the resource (or redeploy it) to an allowed region, or add the region to the list.',
    appliesTo: 'Resources with a region',
    types: null,
    params: [{ key: 'locations', label: 'Allowed regions', kind: 'locations', required: true, placeholder: 'centralindia, southindia' }],
    evaluate: (r, p) => {
      const allowed = listParam(p, 'locations').map((l) => l.toLowerCase().replace(/\s+/g, ''));
      const loc = (r.location ?? '').toLowerCase().replace(/\s+/g, '');
      if (allowed.length === 0 || !loc || loc === 'global') return null;
      return { passed: allowed.includes(loc), detail: `in ${r.location}` };
    },
  },
  {
    key: 'denied-types',
    name: 'Resource type is not on the deny list',
    category: 'governance',
    severity: 'medium',
    description: 'Flags resource types your organisation has decided not to use (classic services, expensive SKUs, unapproved services).',
    remediation: 'Replace the resource with an approved alternative.',
    appliesTo: 'All resources',
    types: null,
    params: [{ key: 'types', label: 'Denied types', kind: 'types', required: true }],
    evaluate: (r, p) => {
      const denied = listParam(p, 'types').map((t) => t.toLowerCase());
      if (denied.length === 0) return null;
      return { passed: !denied.includes(r.type), detail: `${r.type} is not allowed` };
    },
  },
  {
    key: 'allowed-skus',
    name: 'Uses an approved SKU',
    category: 'governance',
    severity: 'medium',
    description: 'Restricts a resource type to approved sizes/tiers (e.g. VM sizes, plan tiers). Scope it to one type.',
    remediation: 'Resize the resource to an approved SKU.',
    appliesTo: 'In-scope resources with a SKU',
    types: null,
    params: [{ key: 'skus', label: 'Approved SKUs', kind: 'stringList', required: true, placeholder: 'B1, B2, P1v3' }],
    evaluate: (r, p) => {
      const skus = listParam(p, 'skus').map((s) => s.toLowerCase());
      if (skus.length === 0 || !r.sku) return null;
      return { passed: skus.includes(r.sku.toLowerCase()), detail: `SKU ${r.sku}` };
    },
  },
  {
    key: 'not-deprecated',
    name: 'Not deprecated or retired',
    category: 'governance',
    severity: 'medium',
    description: 'Resources marked Deprecated/Retired in their lifecycle should be gone.',
    remediation: 'Decommission the resource, or move its lifecycle stage back if it’s still needed.',
    appliesTo: 'All resources',
    types: null,
    evaluate: (r) => ({
      passed: r.lifecycleStage !== 'Deprecated' && r.lifecycleStage !== 'Retired',
      detail: `lifecycle is ${r.lifecycleStage}`,
    }),
  },
  {
    key: 'idle-has-retire-date',
    name: 'Idle resources have a retire-by date',
    category: 'governance',
    severity: 'low',
    description: 'A resource marked not-in-use should have a planned decommission date.',
    remediation: 'Set a retire-by date on the resource, or mark it in use.',
    appliesTo: 'Resources marked not in use',
    types: null,
    evaluate: (r) => (r.inUse === false ? { passed: r.retireBy != null, detail: 'idle without a retire-by date' } : null),
  },
  {
    key: 'retire-date-passed',
    name: 'Not past its retire-by date',
    category: 'governance',
    severity: 'medium',
    description: 'A resource still running after its planned retire-by date was forgotten.',
    remediation: 'Decommission it, or move the retire-by date.',
    appliesTo: 'Resources with a retire-by date',
    types: null,
    evaluate: (r, _p, ctx) =>
      r.retireBy ? { passed: r.retireBy.getTime() >= ctx.now.getTime(), detail: `retire-by was ${r.retireBy.toISOString().slice(0, 10)}` } : null,
  },

  // ─── Operations ───
  {
    key: 'appinsights-workspace-based',
    name: 'Application Insights is workspace-based',
    category: 'operations',
    severity: 'medium',
    description: 'Classic Application Insights was retired in Feb 2024; classic resources stop receiving new features and must be migrated to a Log Analytics workspace.',
    remediation: 'Application Insights → Overview → “Migrate to workspace-based”.',
    appliesTo: 'Application Insights components',
    types: ['microsoft.insights/components'],
    evaluate: (r) => ({ passed: Boolean(prop(r, 'WorkspaceResourceId')), detail: 'classic (not workspace-based)' }),
  },
];

export const TEMPLATES = new Map(RULE_LIBRARY.map((t) => [t.key, t]));

/** Case-insensitive by default; `null` for an invalid pattern (never fails resources). */
export function safeRegex(pattern: string | null | undefined, flags = ''): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}
