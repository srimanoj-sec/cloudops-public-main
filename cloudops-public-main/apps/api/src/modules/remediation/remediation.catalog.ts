import type { RemediationRisk, RuleParamSpec } from '@cloudops/core';
import type { ProviderAction } from '@cloudops/provider-sdk';

/**
 * The remediation action catalog. Every action says exactly what it changes,
 * which rules it fixes, how risky it is and why, whether (and how) it can be
 * undone, and what disruption to expect. Values written to the provider come
 * from here — never from free text — except tag values, which go through the
 * validated tag write-back path.
 *
 * Deliberately NOT here: anything that destroys data (deleting disks,
 * databases, storage). Those stay manual, with a snapshot first.
 */

/** What an action needs to know about a resource to plan against it. */
export interface PlanResource {
  id: string;
  externalId: string;
  name: string;
  type: string; // lower-cased
  state: string;
  owner: string | null;
  tags: Record<string, string>;
  properties: Record<string, unknown>;
}

export interface CurrentState {
  /** Human rendering of the value today. */
  text: string;
  /** Nothing to do (already in the desired state, or not applicable). */
  skip: string | null;
}

interface BaseDef {
  key: string;
  title: string;
  description: string;
  change: string;
  risk: RemediationRisk;
  riskReason: string;
  fixesRules: string[];
  appliesTo: string;
  types: string[] | null;
  params: RuleParamSpec[];
  reversible: boolean;
  rollback: string;
  disruption: string;
  current(r: PlanResource, params: Record<string, unknown>): CurrentState;
  desired(params: Record<string, unknown>): string;
  /** Reject parameters that are present but malformed (message says how to fix). */
  validate?(params: Record<string, unknown>): string | null;
}

/** Changes made through the provider's `actions` capability. */
export interface ProviderActionDef extends BaseDef {
  mode: 'provider';
  build(r: PlanResource, params: Record<string, unknown>): ProviderAction;
  /** Property actions: the path set, so verification can read it back and the cache can be patched. */
  verifyPath?: { path: string; expected: unknown };
}

/** Changes made through tag write-back. */
export interface TagActionDef extends BaseDef {
  mode: 'tags';
  tags(params: Record<string, unknown>, ownerTag: string): Record<string, string>;
  /** The tags ARE the desired full set (restore), rather than merged in. */
  replace?: boolean;
}

export type ActionDef = ProviderActionDef | TagActionDef;

// ── Helpers ────────────────────────────────────────────────────────

function prop(r: PlanResource, path: string): unknown {
  let cur: unknown = r.properties;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
const show = (v: unknown) => (v === undefined || v === null ? 'not set' : String(v));
function tagOf(r: PlanResource, key: string): string | null {
  const k = Object.keys(r.tags).find((t) => t.toLowerCase() === key.toLowerCase());
  return k ? (r.tags[k] ?? null) : null;
}
const str = (params: Record<string, unknown>, key: string) => String(params[key] ?? '').trim();
const powerState = (r: PlanResource) =>
  String(prop(r, 'extended.instanceView.powerState.code') ?? '');

/** A JSON object of string tags from a parameter; {} when it doesn't parse. */
/** Is this a JSON object of tag names to values (as the drift explorer sends)? */
export function isTagsJson(v: unknown): boolean {
  try {
    const obj = JSON.parse(String(v ?? '')) as unknown;
    return Boolean(obj) && typeof obj === 'object' && !Array.isArray(obj);
  } catch {
    return false;
  }
}

export function parseTagsParam(v: unknown): Record<string, string> {
  try {
    const obj = JSON.parse(String(v ?? '{}')) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, val]) => [k, String(val ?? '')]),
    );
  } catch {
    return {};
  }
}
const sameTags = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** A property toggle through a generic ARM update. */
function setProperty(
  def: Omit<
    ProviderActionDef,
    'mode' | 'build' | 'current' | 'desired' | 'verifyPath' | 'params'
  > & {
    path: string;
    value: string | boolean;
    /** Treat a missing property as this value (e.g. old storage accounts: TLS 1.0). */
    missingMeans?: unknown;
    compliant?: (v: unknown) => boolean;
  },
): ProviderActionDef {
  const isCompliant = def.compliant ?? ((v: unknown) => v === def.value);
  return {
    ...def,
    mode: 'provider',
    params: [],
    verifyPath: { path: def.path, expected: def.value },
    current: (r) => {
      const v = prop(r, def.path) ?? def.missingMeans;
      return {
        text: show(v),
        skip: isCompliant(v) ? 'already compliant (as of the last sync)' : null,
      };
    },
    desired: () => String(def.value),
    build: (r) => ({
      kind: 'set-property',
      externalId: r.externalId,
      path: def.path,
      value: def.value,
    }),
  };
}

// ── The catalog ───────────────────────────────────────────────────

export const ACTIONS: ActionDef[] = [
  // ─── Security: property toggles ───
  setProperty({
    key: 'azure.webapp.https-only',
    title: 'Turn on HTTPS Only',
    description:
      'Makes the app answer HTTPS only: plain-HTTP requests are redirected, so credentials and data never travel unencrypted.',
    change: 'Sets httpsOnly = true',
    risk: 'medium',
    riskReason: 'Clients that only speak plain HTTP and can’t follow a redirect stop working.',
    fixesRules: ['https-only'],
    appliesTo: 'Web apps and function apps',
    types: ['microsoft.web/sites'],
    reversible: true,
    rollback: 'Set HTTPS Only back to Off (App Service → Settings → Configuration → General).',
    disruption: 'None — the app is not restarted.',
    path: 'httpsOnly',
    value: true,
  }),
  setProperty({
    key: 'azure.storage.secure-transfer',
    title: 'Require secure transfer',
    description: 'Rejects plain-HTTP (and unencrypted SMB) requests to the storage account.',
    change: 'Sets supportsHttpsTrafficOnly = true',
    risk: 'medium',
    riskReason: 'Anything calling the account over http:// is refused.',
    fixesRules: ['storage-secure-transfer'],
    appliesTo: 'Storage accounts',
    types: ['microsoft.storage/storageaccounts'],
    reversible: true,
    rollback: 'Storage account → Configuration → Secure transfer required = Disabled.',
    disruption: 'None.',
    path: 'supportsHttpsTrafficOnly',
    value: true,
  }),
  setProperty({
    key: 'azure.storage.min-tls',
    title: 'Require TLS 1.2 (storage)',
    description: 'Refuses TLS 1.0/1.1 connections, which are deprecated and vulnerable.',
    change: 'Sets minimumTlsVersion = TLS1_2',
    risk: 'medium',
    riskReason: 'Old clients and SDKs that only speak TLS 1.0/1.1 can no longer connect.',
    fixesRules: ['min-tls-1-2'],
    appliesTo: 'Storage accounts',
    types: ['microsoft.storage/storageaccounts'],
    reversible: true,
    rollback:
      'Storage account → Configuration → Minimum TLS version = the previous value (shown in the run).',
    disruption: 'None.',
    path: 'minimumTlsVersion',
    value: 'TLS1_2',
    missingMeans: 'TLS1_0',
    compliant: (v) => ['TLS1_2', 'TLS1_3'].includes(String(v)),
  }),
  setProperty({
    key: 'azure.redis.min-tls',
    title: 'Require TLS 1.2 (Redis)',
    description: 'Refuses TLS 1.0/1.1 connections to the cache.',
    change: 'Sets minimumTlsVersion = 1.2',
    risk: 'medium',
    riskReason: 'Clients that only speak TLS 1.0/1.1 can no longer connect.',
    fixesRules: ['min-tls-1-2'],
    appliesTo: 'Azure Cache for Redis',
    types: ['microsoft.cache/redis'],
    reversible: true,
    rollback: 'Redis → Advanced settings → Minimum TLS version = the previous value.',
    disruption: 'None.',
    path: 'minimumTlsVersion',
    value: '1.2',
    compliant: (v) => Number(String(v ?? '0').replace('_', '.')) >= 1.2,
  }),
  setProperty({
    key: 'azure.redis.tls-only',
    title: 'Close the non-TLS Redis port',
    description: 'Disables the unencrypted port 6379 so every connection uses TLS (6380).',
    change: 'Sets enableNonSslPort = false',
    risk: 'medium',
    riskReason: 'Clients connecting to port 6379 without TLS are refused.',
    fixesRules: ['redis-tls-only'],
    appliesTo: 'Azure Cache for Redis',
    types: ['microsoft.cache/redis'],
    reversible: true,
    rollback: 'Redis → Advanced settings → Allow access only via SSL = No.',
    disruption: 'None.',
    path: 'enableNonSslPort',
    value: false,
  }),
  setProperty({
    key: 'azure.storage.no-public-blob',
    title: 'Disable anonymous blob access',
    description:
      'Stops any container from being made anonymously readable — a common source of data leaks.',
    change: 'Sets allowBlobPublicAccess = false',
    risk: 'high',
    riskReason:
      'Anything reading blobs without credentials — public sites, shared links, CDN origins — stops working at once.',
    fixesRules: ['storage-no-public-blob'],
    appliesTo: 'Storage accounts',
    types: ['microsoft.storage/storageaccounts'],
    reversible: true,
    rollback:
      'Storage account → Configuration → Allow Blob anonymous access = Enabled (containers keep their access level).',
    disruption: 'Anonymous readers lose access immediately.',
    path: 'allowBlobPublicAccess',
    value: false,
  }),
  setProperty({
    key: 'azure.acr.disable-admin',
    title: 'Disable the registry admin user',
    description:
      'Removes the shared admin username/password; pushes and pulls then need an identity or token.',
    change: 'Sets adminUserEnabled = false',
    risk: 'high',
    riskReason:
      'Pipelines, clusters or apps using the admin credentials lose access — move them to managed identity or tokens first.',
    fixesRules: ['acr-admin-disabled'],
    appliesTo: 'Container registries',
    types: ['microsoft.containerregistry/registries'],
    reversible: true,
    rollback: 'Registry → Access keys → Admin user = Enabled (new passwords are generated).',
    disruption: 'Anything using the admin credentials fails from now on.',
    path: 'adminUserEnabled',
    value: false,
  }),
  setProperty({
    key: 'azure.keyvault.purge-protection',
    title: 'Turn on Key Vault purge protection',
    description:
      'Deleted vaults and secrets can’t be purged before the retention period ends — protects against malicious or accidental destruction.',
    change: 'Sets enablePurgeProtection = true',
    risk: 'high',
    riskReason: 'Permanent: purge protection can never be turned off again for this vault.',
    fixesRules: ['keyvault-purge-protection'],
    appliesTo: 'Key vaults',
    types: ['microsoft.keyvault/vaults'],
    reversible: false,
    rollback: 'None — Azure does not allow turning purge protection off.',
    disruption: 'None.',
    path: 'enablePurgeProtection',
    value: true,
  }),

  // ─── Cost / operations: power ───
  {
    key: 'azure.vm.deallocate-stopped',
    mode: 'provider',
    title: 'Deallocate stopped VMs',
    description:
      'A VM stopped from inside the guest OS keeps its compute reserved — and billed. Deallocating releases it.',
    change: 'az vm deallocate',
    risk: 'medium',
    riskReason: 'A dynamic public IP is released, and temporary-disk contents are lost.',
    fixesRules: ['vm-stopped-not-deallocated'],
    appliesTo: 'Virtual machines (stopped, not deallocated)',
    types: ['microsoft.compute/virtualmachines'],
    params: [],
    reversible: true,
    rollback: 'Start the VM again (Resource → Actions → Start).',
    disruption: 'None — the VM is already stopped.',
    current: (r) => {
      const s = powerState(r);
      return {
        text: s || 'unknown',
        skip:
          s === 'PowerState/stopped'
            ? null
            : s
              ? 'not in the stopped-but-allocated state'
              : 'power state unknown until the next sync',
      };
    },
    desired: () => 'PowerState/deallocated',
    build: (r) => ({ kind: 'power', externalId: r.externalId, operation: 'deallocate' }),
  },
  {
    key: 'azure.vm.start',
    mode: 'provider',
    title: 'Start VM',
    description: 'Starts a deallocated or stopped virtual machine.',
    change: 'az vm start',
    risk: 'low',
    riskReason: 'Compute billing resumes.',
    fixesRules: [],
    appliesTo: 'Virtual machines',
    types: ['microsoft.compute/virtualmachines'],
    params: [],
    reversible: true,
    rollback: 'Stop (deallocate) it again.',
    disruption: 'None.',
    current: (r) => {
      const s = powerState(r);
      return { text: s || 'unknown', skip: s === 'PowerState/running' ? 'already running' : null };
    },
    desired: () => 'PowerState/running',
    build: (r) => ({ kind: 'power', externalId: r.externalId, operation: 'start' }),
  },
  {
    key: 'azure.vm.restart',
    mode: 'provider',
    title: 'Restart VM',
    description: 'Reboots a running virtual machine.',
    change: 'az vm restart',
    risk: 'medium',
    riskReason: 'The VM reboots — a few minutes of downtime for whatever runs on it.',
    fixesRules: [],
    appliesTo: 'Virtual machines (running)',
    types: ['microsoft.compute/virtualmachines'],
    params: [],
    reversible: true,
    rollback: 'Not applicable.',
    disruption: 'A few minutes of downtime.',
    current: (r) => {
      const s = powerState(r);
      return { text: s || 'unknown', skip: s && s !== 'PowerState/running' ? 'not running' : null };
    },
    desired: () => 'PowerState/running (rebooted)',
    build: (r) => ({ kind: 'power', externalId: r.externalId, operation: 'restart' }),
  },
  {
    key: 'azure.vm.stop',
    mode: 'provider',
    title: 'Stop VM (deallocate)',
    description: 'Shuts the VM down and releases its compute, which stops the compute charge.',
    change: 'az vm deallocate',
    risk: 'high',
    riskReason: 'Takes the VM and everything on it offline; a dynamic public IP is released.',
    fixesRules: [],
    appliesTo: 'Virtual machines (running)',
    types: ['microsoft.compute/virtualmachines'],
    params: [],
    reversible: true,
    rollback: 'Start the VM again.',
    disruption: 'Downtime until it is started again.',
    current: (r) => {
      const s = powerState(r);
      return {
        text: s || 'unknown',
        skip: s === 'PowerState/deallocated' ? 'already deallocated' : null,
      };
    },
    desired: () => 'PowerState/deallocated',
    build: (r) => ({ kind: 'power', externalId: r.externalId, operation: 'deallocate' }),
  },

  // ─── Cost: remove unused leftovers (no data involved) ───
  {
    key: 'azure.network.delete-unused-public-ip',
    mode: 'provider',
    title: 'Delete unused public IPs',
    description: 'A static public IP is billed even when attached to nothing.',
    change: 'az resource delete',
    risk: 'high',
    riskReason:
      'Permanent: the address is released and a new IP won’t be the same address (DNS records or allow-lists pointing at it break).',
    fixesRules: ['unassociated-public-ip'],
    appliesTo: 'Public IP addresses not associated with anything',
    types: ['microsoft.network/publicipaddresses'],
    params: [],
    reversible: false,
    rollback: 'None — create a new public IP if needed (it will have a different address).',
    disruption: 'None — it is not attached.',
    current: (r) => {
      const attached = prop(r, 'ipConfiguration') != null || prop(r, 'natGateway') != null;
      return {
        text: attached
          ? 'attached'
          : `unassociated${prop(r, 'ipAddress') ? ` (${show(prop(r, 'ipAddress'))})` : ''}`,
        skip: attached ? 'it is attached to something' : null,
      };
    },
    desired: () => 'deleted',
    build: (r) => ({ kind: 'delete', externalId: r.externalId }),
  },
  {
    key: 'azure.network.delete-orphaned-nic',
    mode: 'provider',
    title: 'Delete orphaned network interfaces',
    description: 'A NIC attached to no VM or private endpoint is clutter left from a deleted VM.',
    change: 'az resource delete',
    risk: 'medium',
    riskReason: 'Permanent: the NIC’s configuration (private IP, NSG link) is gone.',
    fixesRules: ['orphaned-nic'],
    appliesTo: 'Network interfaces attached to nothing',
    types: ['microsoft.network/networkinterfaces'],
    params: [],
    reversible: false,
    rollback: 'None — create a new NIC if needed.',
    disruption: 'None — nothing uses it.',
    current: (r) => {
      const used =
        prop(r, 'virtualMachine') != null ||
        prop(r, 'privateEndpoint') != null ||
        prop(r, 'privateLinkService') != null;
      return { text: used ? 'in use' : 'attached to nothing', skip: used ? 'it is in use' : null };
    },
    desired: () => 'deleted',
    build: (r) => ({ kind: 'delete', externalId: r.externalId }),
  },
  {
    key: 'azure.appservice.delete-empty-plan',
    mode: 'provider',
    title: 'Delete empty App Service plans',
    description: 'A dedicated plan is billed per instance whether or not any app runs on it.',
    change: 'az resource delete',
    risk: 'high',
    riskReason: 'Permanent: the plan’s scale settings are gone; deploying later needs a new plan.',
    fixesRules: ['empty-app-service-plan'],
    appliesTo: 'App Service plans hosting no apps',
    types: ['microsoft.web/serverfarms'],
    params: [],
    reversible: false,
    rollback: 'None — create a new plan if needed.',
    disruption: 'None — it hosts no apps.',
    current: (r) => {
      const n = Number(prop(r, 'numberOfSites') ?? NaN);
      return {
        text: Number.isFinite(n) ? `${n} app(s)` : 'unknown',
        skip: !Number.isFinite(n) ? 'app count unknown' : n > 0 ? 'it hosts apps' : null,
      };
    },
    desired: () => 'deleted',
    build: (r) => ({ kind: 'delete', externalId: r.externalId }),
  },

  // ─── Tagging & ownership ───
  {
    key: 'tags.assign-owner',
    mode: 'tags',
    title: 'Assign an owner',
    description: 'Writes the owner tag, making a person or team accountable for the resource.',
    change: 'Sets the owner tag',
    risk: 'low',
    riskReason: 'Tags only — nothing about the resource’s behaviour changes.',
    fixesRules: ['owner-present'],
    appliesTo: 'All resources',
    types: null,
    params: [
      {
        key: 'owner',
        label: 'Owner',
        kind: 'string',
        required: true,
        placeholder: 'team-platform or jane@contoso.com',
      },
    ],
    reversible: true,
    rollback: 'Edit or remove the tag (Resource → Tags).',
    disruption: 'None.',
    current: (r, p) => ({
      text: r.owner ?? 'no owner',
      skip: r.owner && r.owner === str(p, 'owner') ? 'already has this owner' : null,
    }),
    desired: (p) => str(p, 'owner') || '(owner)',
    tags: (p, ownerTag) => ({ [ownerTag]: str(p, 'owner') }),
  },
  {
    key: 'tags.set-environment',
    mode: 'tags',
    title: 'Set the environment tag',
    description:
      'Marks resources as prod / staging / dev / test, which production-only rules and cost showback rely on.',
    change: 'Sets environment = <value>',
    risk: 'low',
    riskReason: 'Tags only.',
    fixesRules: ['env-tag'],
    appliesTo: 'All resources',
    types: null,
    params: [
      {
        key: 'environment',
        label: 'Environment',
        kind: 'string',
        required: true,
        placeholder: 'prod, staging, dev or test',
      },
    ],
    reversible: true,
    rollback: 'Edit or remove the tag.',
    disruption: 'None.',
    current: (r, p) => {
      const v = tagOf(r, 'environment') ?? tagOf(r, 'env');
      return {
        text: v ?? 'no environment tag',
        skip: v && v === str(p, 'environment') ? 'already tagged' : null,
      };
    },
    desired: (p) => `environment=${str(p, 'environment') || '(value)'}`,
    tags: (p) => ({ environment: str(p, 'environment') }),
  },
  {
    key: 'tags.restore',
    mode: 'tags',
    replace: true,
    title: 'Restore previous tags',
    description:
      'Puts a resource’s tags back to what they were before a detected change (tag drift).',
    change: 'Replaces the tag set with the earlier one',
    risk: 'low',
    riskReason: 'Tags only — but tags added since then are removed.',
    fixesRules: [],
    appliesTo: 'The resource whose tags drifted',
    types: null,
    params: [
      {
        key: 'tags',
        label: 'Tags to restore (JSON)',
        kind: 'string',
        required: true,
        help: 'Filled in from the drift event.',
      },
    ],
    reversible: true,
    rollback: 'The current tags are kept in the run record; restore them the same way.',
    disruption: 'None.',
    // Never let a malformed value become "replace every tag with nothing".
    validate: (p) =>
      isTagsJson(p.tags)
        ? null
        : 'The tags to restore must be a JSON object of tag names to values.',
    current: (r, p) => {
      const want = parseTagsParam(p.tags);
      return {
        text: JSON.stringify(r.tags),
        skip: sameTags(r.tags, want) ? 'already has exactly these tags' : null,
      };
    },
    desired: (p) => JSON.stringify(parseTagsParam(p.tags)),
    tags: (p) => parseTagsParam(p.tags),
  },
  {
    key: 'tags.add',
    mode: 'tags',
    title: 'Add a tag',
    description: 'Adds (or updates) one tag on every selected resource.',
    change: 'Sets <key> = <value>',
    risk: 'low',
    riskReason: 'Tags only.',
    fixesRules: ['has-tags', 'required-tags'],
    appliesTo: 'All resources',
    types: null,
    params: [
      { key: 'key', label: 'Tag key', kind: 'tagKey', required: true, placeholder: 'cost-center' },
      { key: 'value', label: 'Value', kind: 'string', required: true, placeholder: 'CC-1234' },
    ],
    reversible: true,
    rollback: 'Remove the tag.',
    disruption: 'None.',
    current: (r, p) => {
      const v = tagOf(r, str(p, 'key'));
      return {
        text: v ?? 'not set',
        skip: v !== null && v === str(p, 'value') ? 'already tagged' : null,
      };
    },
    desired: (p) => `${str(p, 'key') || '(key)'}=${str(p, 'value') || '(value)'}`,
    tags: (p) => ({ [str(p, 'key')]: str(p, 'value') }),
  },
];

export const ACTION_INDEX = new Map(ACTIONS.map((a) => [a.key, a]));

/** Library rule template → the actions that fix it. */
export function actionsForTemplate(template: string | null | undefined): ActionDef[] {
  if (!template) return [];
  return ACTIONS.filter((a) => a.fixesRules.includes(template));
}

export function isRemediableTemplate(template: string | null | undefined): boolean {
  return actionsForTemplate(template).length > 0;
}

/** Required parameters missing from a request. */
export function missingActionParams(def: ActionDef, params: Record<string, unknown>): string[] {
  return def.params
    .filter((p) => p.required && !String(params[p.key] ?? '').trim())
    .map((p) => p.label);
}
