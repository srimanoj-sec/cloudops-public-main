import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialContext } from '@cloudops/credentials';
import type { ProviderContext, Scope } from '@cloudops/provider-sdk';

// Mock the hardened executor so the provider logic can be tested without `az`.
// Only `az` is faked — AzError stays real, since the provider branches on it.
vi.mock('./az-exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./az-exec.js')>()),
  az: vi.fn(),
}));
import { az, AzError } from './az-exec.js';
import { AzureProvider, type AzureAccount } from './azure-provider.js';

const mockAz = vi.mocked(az);
/**
 * Per-org CLI profiles land here in tests — never in the real tmp root. A fresh
 * directory per test, so one test's async profile pruning can't touch another's.
 */
let profilesDir = mkdtempSync(join(tmpdir(), 'cloudops-test-profiles-'));
beforeEach(() => {
  profilesDir = mkdtempSync(join(tmpdir(), 'cloudops-test-profiles-'));
});

const ctx: ProviderContext = {
  credential: { source: 'env', metadata: {} } as CredentialContext,
  log: () => undefined,
};

const accounts: AzureAccount[] = [
  { name: 'Org A', tenantId: 'tA', clientId: 'appA', clientSecret: 'secA' },
  { name: 'Org B', tenantId: 'tB', clientId: 'appB', clientSecret: 'secB' },
];

/**
 * Fake `az` responses:
 *  - Org A's SP sees sub1, sub2.
 *  - Org B's SP sees sub2 (cross-tenant guest) and sub3.
 * sub2 is therefore visible to BOTH orgs — the provider must attribute it to the
 * first org that claimed it (Org A) and never emit it twice.
 */
function wireAz() {
  mockAz.mockImplementation(async (args: string[]) => {
    const [cmd, sub] = args;
    if (cmd === 'account' && sub === 'clear') return undefined as never;
    if (cmd === 'login') {
      const tenant = args[args.indexOf('--tenant') + 1];
      if (tenant === 'tA')
        return [
          { id: 'sub1', name: 'Sub One', tenantId: 'tA', state: 'Enabled' },
          { id: 'sub2', name: 'Sub Two', tenantId: 'tA', state: 'Enabled' },
        ] as never;
      if (tenant === 'tB')
        return [
          { id: 'sub2', name: 'Sub Two (guest)', tenantId: 'tB', state: 'Enabled' },
          { id: 'sub3', name: 'Sub Three', tenantId: 'tB', state: 'Enabled' },
        ] as never;
      return [] as never;
    }
    if (cmd === 'group' && sub === 'list') {
      const subId = args[args.indexOf('--subscription') + 1];
      return [
        { id: `/subscriptions/${subId}/resourceGroups/rg-${subId}`, name: `rg-${subId}`, location: 'eastus' },
      ] as never;
    }
    if (cmd === 'account' && sub === 'show')
      return { id: 'sub1', name: 'Sub One', tenantId: 'tA' } as never;
    // Cost Management query (az rest): an empty result set.
    if (cmd === 'rest') return { properties: { columns: [], rows: [] } } as never;
    return undefined as never;
  });
}

async function collect(iter: AsyncIterable<Scope>): Promise<Scope[]> {
  const out: Scope[] = [];
  for await (const s of iter) out.push(s);
  return out;
}

describe('AzureProvider multi-org discovery', () => {
  beforeEach(() => {
    mockAz.mockReset();
    wireAz();
  });

  it('dedupes cross-tenant subscriptions, attributing each to the first org that sees it', async () => {
    const provider = new AzureProvider({ accounts, profilesDir });
    const scopes = await collect(provider.discoverScopes(ctx));
    const subs = scopes.filter((s) => s.kind === 'subscription');

    // sub1, sub2, sub3 — sub2 appears exactly once (not double-counted).
    expect(subs.map((s) => s.externalId).sort()).toEqual(['sub1', 'sub2', 'sub3']);

    const byId = Object.fromEntries(subs.map((s) => [s.externalId, s]));
    // sub2 was claimed by Org A first, so it stays attributed to Org A.
    expect(byId.sub2?.metadata?.orgName).toBe('Org A');
    expect(byId.sub2?.metadata?.tenantId).toBe('tA');
    // sub3 is only visible to Org B.
    expect(byId.sub3?.metadata?.orgName).toBe('Org B');
    expect(byId.sub3?.metadata?.tenantId).toBe('tB');
  });

  it('logs each org in exactly once, each into its own isolated profile', async () => {
    const provider = new AzureProvider({ accounts, profilesDir });
    await collect(provider.discoverScopes(ctx));

    const logins = mockAz.mock.calls.filter((c) => c[0][0] === 'login');
    expect(logins).toHaveLength(2);
    // No shared profile to clear any more.
    expect(mockAz.mock.calls.filter((c) => c[0][0] === 'account' && c[0][1] === 'clear')).toHaveLength(0);
    // Two different profile directories, both under the configured root.
    const dirs = logins.map((c) => c[1]?.configDir as string);
    expect(new Set(dirs).size).toBe(2);
    for (const d of dirs) expect(d.startsWith(profilesDir)).toBe(true);
  });

  it('reports per-org connectivity independently via testConnections', async () => {
    const provider = new AzureProvider({ accounts, profilesDir });
    const results = await provider.testConnections(ctx);

    expect(results.map((r) => r.account)).toEqual(['Org A', 'Org B']);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]?.subscriptions).toBe(2);
  });
});

describe('AzureProvider runtime-editable accounts', () => {
  beforeEach(() => {
    mockAz.mockReset();
    wireAz();
  });

  it('re-reads the account list on every use so UI edits apply without a restart', async () => {
    let current: AzureAccount[] = [accounts[0]!];
    const provider = new AzureProvider({ accounts: () => current, profilesDir });

    const first = await collect(provider.discoverScopes(ctx));
    expect(first.filter((s) => s.kind === 'subscription').map((s) => s.externalId)).toEqual([
      'sub1',
      'sub2',
    ]);

    // An org added on the Providers page mid-flight.
    current = accounts;
    const second = await collect(provider.discoverScopes(ctx));
    expect(second.filter((s) => s.kind === 'subscription').map((s) => s.externalId)).toEqual([
      'sub1',
      'sub2',
      'sub3',
    ]);
  });

  it('re-authenticates after a secret is rotated instead of reusing the cached session', async () => {
    let current: AzureAccount[] = [accounts[0]!];
    const provider = new AzureProvider({ accounts: () => current, profilesDir });
    await provider.getCost('sub1', { from: '2026-01-01', to: '2026-01-02' }, ctx);
    const loginsBefore = mockAz.mock.calls.filter((c) => c[0][0] === 'login').length;

    current = [{ ...accounts[0]!, clientSecret: 'rotated' }];
    await provider.getCost('sub1', { from: '2026-01-01', to: '2026-01-02' }, ctx);

    const logins = mockAz.mock.calls.filter((c) => c[0][0] === 'login');
    expect(logins.length).toBeGreaterThan(loginsBefore);
    expect(logins.at(-1)?.[0][logins.at(-1)![0].indexOf('-p') + 1]).toBe('rotated');
  });
});

describe('AzureProvider credential tests are non-destructive', () => {
  beforeEach(() => {
    mockAz.mockReset();
    wireAz();
  });

  it('validates unsaved credentials in a throwaway profile, never clearing the live session', async () => {
    const provider = new AzureProvider({ accounts, profilesDir });
    const result = await provider.testAccountCredentials(
      { name: 'Candidate', tenantId: 'tA', clientId: 'appA', clientSecret: 'secA' },
      ctx,
    );

    expect(result).toMatchObject({ account: 'Candidate', ok: true, subscriptions: 2 });
    const calls = mockAz.mock.calls;
    expect(calls.filter((c) => c[0][0] === 'account' && c[0][1] === 'clear')).toHaveLength(0);
    // The login ran against a temp CLI profile, not the platform's config dir.
    const login = calls.find((c) => c[0][0] === 'login');
    expect(login?.[1]?.configDir).toMatch(/cloudops-az-/);
  });

  it('rejects an incomplete credential set without shelling out', async () => {
    const provider = new AzureProvider({ accounts, profilesDir });
    const result = await provider.testAccountCredentials({ name: 'Half', tenantId: 'tA' }, ctx);

    expect(result.ok).toBe(false);
    expect(mockAz).not.toHaveBeenCalled();
  });

  it('does not clear the shared profile when testing every configured org', async () => {
    const provider = new AzureProvider({ accounts, profilesDir });
    await provider.testConnections(ctx);

    expect(mockAz.mock.calls.filter((c) => c[0][0] === 'account' && c[0][1] === 'clear')).toHaveLength(0);
  });
});

describe('AzureProvider per-org profile isolation', () => {
  beforeEach(() => {
    mockAz.mockReset();
    wireAz();
  });

  /** Tenant id → the profile dir its logins used, for the given provider's calls. */
  function loginDirs(): Map<string, string> {
    const m = new Map<string, string>();
    for (const c of mockAz.mock.calls.filter((x) => x[0][0] === 'login')) {
      m.set(c[0][c[0].indexOf('--tenant') + 1]!, c[1]!.configDir!);
    }
    return m;
  }

  it('reports a failed cost query with its reason instead of returning no cost', async () => {
    const provider = new AzureProvider({ accounts, profilesDir });
    await expect(provider.getCost('sub-nobody-sees', { from: '2026-01-01', to: '2026-01-02' }, ctx)).rejects.toMatchObject({
      name: 'CostQueryError',
      kind: 'no-access',
    });

    mockAz.mockImplementation(async (args: string[]) => {
      if (args[0] === 'login') return [{ id: 'sub1', name: 'Sub One', tenantId: 'tA', state: 'Enabled' }] as never;
      if (args[0] === 'rest') throw new AzError('az failed: ERROR: (RBACAccessDenied) The client does not have authorization.', 'CLI_ERROR');
      return undefined as never;
    });
    const fresh = new AzureProvider({ accounts, profilesDir });
    await expect(fresh.getCost('sub1', { from: '2026-01-01', to: '2026-01-02' }, ctx)).rejects.toMatchObject({ kind: 'no-access' });
  });

  it("runs every call for a subscription under the owning org's profile", async () => {
    const provider = new AzureProvider({ accounts, profilesDir });
    await collect(provider.discoverScopes(ctx));
    const dirs = loginDirs();

    await provider.getCost('sub3', { from: '2026-01-01', to: '2026-01-02' }, ctx);
    await provider.getCost('sub1', { from: '2026-01-01', to: '2026-01-02' }, ctx);
    const restCalls = mockAz.mock.calls.filter((c) => c[0][0] === 'rest');
    // sub3 belongs to Org B, sub1 to Org A — each cost call used that org's dir.
    expect(restCalls[0]?.[1]?.configDir).toBe(dirs.get('tB'));
    expect(restCalls.at(-1)?.[1]?.configDir).toBe(dirs.get('tA'));
    // Resource-group listing during discovery also ran in the owning org's profile.
    const groupCalls = mockAz.mock.calls.filter((c) => c[0][0] === 'group');
    const sub3Groups = groupCalls.find((c) => c[0].includes('sub3'));
    expect(sub3Groups?.[1]?.configDir).toBe(dirs.get('tB'));
  });

  it('shares one in-flight login between concurrent callers for the same org', async () => {
    const provider = new AzureProvider({ accounts: [accounts[0]!], profilesDir });
    await Promise.all([
      provider.getCost('sub1', { from: '2026-01-01', to: '2026-01-02' }, ctx),
      provider.getCost('sub2', { from: '2026-01-01', to: '2026-01-02' }, ctx),
      provider.updateResourceTags('/subscriptions/sub1/resourceGroups/rg', 'Merge', { a: 'b' }, ctx),
    ]);
    expect(mockAz.mock.calls.filter((c) => c[0][0] === 'login')).toHaveLength(1);
  });

  it('re-authenticates once and retries when the org session has expired', async () => {
    const provider = new AzureProvider({ accounts: [accounts[0]!], profilesDir });
    let failedOnce = false;
    mockAz.mockImplementation(async (args: string[]) => {
      if (args[0] === 'login') return [{ id: 'sub1', name: 'Sub One', tenantId: 'tA', state: 'Enabled' }] as never;
      if (args[0] === 'tag' && !failedOnce) {
        failedOnce = true;
        throw new AzError('No active Azure CLI session. Run `az login`.', 'NOT_LOGGED_IN');
      }
      if (args[0] === 'tag') return { properties: { tags: { a: 'b' } } } as never;
      if (args[0] === 'rest') return { properties: { columns: [], rows: [] } } as never;
      return undefined as never;
    });
    const tags = await provider.updateResourceTags('/subscriptions/sub1/resourceGroups/rg', 'Merge', { a: 'b' }, ctx);
    expect(tags).toEqual({ a: 'b' });
    expect(mockAz.mock.calls.filter((c) => c[0][0] === 'login')).toHaveLength(2);
  });

  it('refuses to run a subscription no configured org can see (no cross-tenant fallback)', async () => {
    const provider = new AzureProvider({ accounts, profilesDir });
    await expect(
      provider.updateResourceTags('/subscriptions/unknown-sub/resourceGroups/rg', 'Merge', { a: 'b' }, ctx),
    ).rejects.toThrow(/not visible to any configured organization/);
    expect(mockAz.mock.calls.filter((c) => c[0][0] === 'tag')).toHaveLength(0);
  });

  it('deletes the on-disk profile of an org that was removed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloudops-prune-'));
    let current: AzureAccount[] = accounts;
    const provider = new AzureProvider({ accounts: () => current, profilesDir: root });
    await collect(provider.discoverScopes(ctx));
    const dirs = loginDirs();
    for (const d of dirs.values()) mkdirSync(d, { recursive: true }); // what az leaves behind

    current = [accounts[0]!]; // Org B removed on the Providers page
    await collect(provider.discoverScopes(ctx));
    await new Promise((r) => setTimeout(r, 50)); // pruning is async best-effort
    expect(existsSync(dirs.get('tB')!)).toBe(false);
    expect(existsSync(dirs.get('tA')!)).toBe(true);
  });
});
