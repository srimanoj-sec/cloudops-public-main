/**
 * @cloudops/provider-azure — the first CloudProvider implementation.
 * Uses Azure CLI through a hardened executor, reusing the host `az login`.
 */
export { az, AzError, READ_ONLY_AZ_GROUPS, type AzExecOptions } from './az-exec.js';
export { createAzureCliProbe } from './probe.js';
export { AzureProvider, type AzureProviderOptions, type AzureAccount } from './azure-provider.js';
export { createAzurePlugin } from './plugin.js';
export * from './mappers.js';
