import { createToken } from '@cloudops/kernel';
import type { CloudProvider } from './types.js';

/**
 * Provider registry — the single lookup the core uses to find providers.
 * Registering a provider is one call; the core stays closed to modification.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, CloudProvider>();

  register(provider: CloudProvider): void {
    if (this.providers.has(provider.key)) {
      throw new Error(`Provider already registered: ${provider.key}`);
    }
    this.providers.set(provider.key, provider);
  }

  get(key: string): CloudProvider {
    const p = this.providers.get(key);
    if (!p) throw new Error(`Unknown provider: ${key}`);
    return p;
  }

  has(key: string): boolean {
    return this.providers.has(key);
  }

  list(): CloudProvider[] {
    return [...this.providers.values()];
  }
}

/** Shared DI token so the core and provider plugins agree on the registry. */
export const PROVIDER_REGISTRY = createToken<ProviderRegistry>('ProviderRegistry');
