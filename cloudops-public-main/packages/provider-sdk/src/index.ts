/**
 * @cloudops/provider-sdk — the provider abstraction. Defines the CloudProvider
 * contract and the registry the core discovers providers through. Azure is the
 * first implementation (`@cloudops/provider-azure`); future providers implement
 * the same interface with zero core changes.
 */
export * from './types.js';
export * from './errors.js';
export { ProviderRegistry, PROVIDER_REGISTRY } from './registry.js';
