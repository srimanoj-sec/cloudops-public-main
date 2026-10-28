import type { Plugin } from '@cloudops/kernel';
import { PROVIDER_REGISTRY } from '@cloudops/provider-sdk';
import { GcpProvider, type GcpAccount } from './gcp-provider.js';

export function createGcpPlugin(accounts: () => GcpAccount[]): Plugin {
  return {
    id: 'provider:gcp',
    kind: 'provider',
    register(ctx) {
      ctx.container.resolve(PROVIDER_REGISTRY).register(new GcpProvider(accounts));
    },
  };
}
