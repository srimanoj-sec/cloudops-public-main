import { describe, expect, it } from 'vitest';
import { AzureCliCredentialProvider, CredentialChain } from './index.js';

describe('credential chain', () => {
  it('resolves via azure-cli when a session exists and never returns a stored secret', async () => {
    const provider = new AzureCliCredentialProvider({
      accountShow: async () => ({ tenantId: 't1', subscriptionId: 's1', name: 'Dev Sub' }),
    });
    const chain = new CredentialChain([provider]);
    const ctx = await chain.resolve({ providerKey: 'azure' });

    expect(ctx.source).toBe('azure-cli');
    expect(ctx.metadata.tenantId).toBe('t1');
    expect(ctx.secret).toBeUndefined(); // secret never copied out of the az session
  });

  it('throws a clear error when no source is available', async () => {
    const provider = new AzureCliCredentialProvider({ accountShow: async () => null });
    const chain = new CredentialChain([provider]);
    await expect(chain.resolve({ providerKey: 'azure' })).rejects.toThrow(/No credential source/);
  });
});
