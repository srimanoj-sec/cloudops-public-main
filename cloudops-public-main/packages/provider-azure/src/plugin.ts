import type { Plugin, PluginContext } from '@cloudops/kernel';
import { PROVIDER_REGISTRY } from '@cloudops/provider-sdk';
import { AzureProvider, type AzureProviderOptions } from './azure-provider.js';

/**
 * Kernel plugin that registers the Azure provider into the shared
 * ProviderRegistry. Adding any future provider follows this exact shape —
 * a package + a one-line `plugins.use(...)` in the composition root.
 */
export function createAzurePlugin(options: AzureProviderOptions = {}): Plugin {
  return {
    id: 'provider:azure',
    kind: 'provider',
    register(ctx: PluginContext) {
      const registry = ctx.container.resolve(PROVIDER_REGISTRY);
      registry.register(new AzureProvider(options));
    },
  };
}
