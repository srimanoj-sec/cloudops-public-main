import { describe, expect, it } from 'vitest';
import { noopLogger } from '@cloudops/kernel';
import type { EncryptedJsonStore } from '@cloudops/credentials';
import {
  ProviderAccountsService,
  type ProviderAccountsDocument,
} from './provider-accounts.service.js';

/** In-memory stand-in for the encrypted store — same contract, no filesystem. */
function fakeStore(initial: ProviderAccountsDocument | null = null) {
  let doc = initial;
  return {
    path: '(memory)',
    keyIsExternal: false,
    read: async () => doc,
    write: async (value: ProviderAccountsDocument) => {
      doc = value;
    },
    get current() {
      return doc;
    },
  } as unknown as EncryptedJsonStore<ProviderAccountsDocument> & {
    current: ProviderAccountsDocument | null;
  };
}

const ENV_ORG = {
  name: 'From env',
  tenantId: 'AAAAAAAA-0000-0000-0000-000000000001',
  clientId: 'bbbbbbbb-0000-0000-0000-000000000001',
  clientSecret: 'env-secret',
};

const NEW_ORG = {
  name: 'From UI',
  tenantId: 'cccccccc-0000-0000-0000-000000000002',
  clientId: 'dddddddd-0000-0000-0000-000000000002',
  clientSecret: 'ui-secret',
  enabled: true,
};

async function service(envAccounts = [ENV_ORG], store = fakeStore()) {
  const svc = new ProviderAccountsService(store, envAccounts, noopLogger);
  await svc.init();
  return { svc, store };
}

describe('provider accounts', () => {
  it('merges env orgs with stored ones and never exposes a secret', async () => {
    const { svc } = await service();
    await svc.create('azure', NEW_ORG);

    const listed = svc.list('azure');
    expect(listed.map((a) => a.source)).toEqual(['store', 'env']);
    expect(listed.every((a) => a.secretSet)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('ui-secret');
    expect(JSON.stringify(listed)).not.toContain('env-secret');

    expect(svc.resolve('azure').map((a) => a.name)).toEqual(['From UI', 'From env']);
  });

  it('lets a stored org take over a tenant still declared in .env', async () => {
    const { svc } = await service();
    await svc.create('azure', { ...NEW_ORG, name: 'Migrated', tenantId: ENV_ORG.tenantId });

    // One login per tenant, using the credentials most recently entered.
    const resolved = svc.resolve('azure');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ name: 'Migrated', clientSecret: 'ui-secret' });
    // The shadowed env row stays visible, marked inactive.
    expect(svc.list('azure').find((a) => a.source === 'env')?.enabled).toBe(false);
  });

  it('skips paused orgs when resolving, but still lists them', async () => {
    const { svc } = await service([]);
    const created = await svc.create('azure', NEW_ORG);
    await svc.update('azure', created.id, { enabled: false });

    expect(svc.resolve('azure')).toHaveLength(0);
    expect(svc.list('azure')).toHaveLength(1);
    expect(svc.status('azure')).toMatchObject({ storeCount: 1, envCount: 0, hostMode: true });
  });

  it('keeps the stored secret when an update omits it, and rotates it when given', async () => {
    const { svc } = await service([]);
    const created = await svc.create('azure', NEW_ORG);

    await svc.update('azure', created.id, { name: 'Renamed' });
    expect(svc.credentialsFor('azure', created.id).clientSecret).toBe('ui-secret');

    await svc.update('azure', created.id, { clientSecret: 'rotated' });
    expect(svc.credentialsFor('azure', created.id).clientSecret).toBe('rotated');
  });

  it('rejects a second org with the same tenant + client id', async () => {
    const { svc } = await service([]);
    await svc.create('azure', NEW_ORG);
    await expect(svc.create('azure', { ...NEW_ORG, name: 'Copy' })).rejects.toThrow(/already uses/);
  });

  it('refuses to edit or delete an org that comes from the environment', async () => {
    const { svc } = await service();
    const envRow = svc.list('azure').find((a) => a.source === 'env')!;

    expect(envRow.editable).toBe(false);
    await expect(svc.update('azure', envRow.id, { name: 'nope' })).rejects.toThrow(/environment/);
    await expect(svc.remove('azure', envRow.id)).rejects.toThrow(/environment/);
    // ...but it can still be connectivity-tested from the UI.
    expect(svc.credentialsFor('azure', envRow.id).clientSecret).toBe('env-secret');
  });

  it('persists through the store so credentials survive a restart', async () => {
    const { svc, store } = await service([]);
    await svc.create('azure', NEW_ORG);

    const restarted = new ProviderAccountsService(store, [], noopLogger);
    await restarted.init();
    expect(restarted.resolve('azure')).toHaveLength(1);
  });
});
