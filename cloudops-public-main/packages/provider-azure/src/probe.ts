import type { AzureCliProbe } from '@cloudops/credentials';
import { az, AzError } from './az-exec.js';

interface AzAccountShow {
  tenantId: string;
  id: string; // subscription id
  name: string;
  user?: { name?: string };
}

/** Probes the active `az login` session via `az account show`. */
export function createAzureCliProbe(configDir?: string): AzureCliProbe {
  return {
    async accountShow() {
      try {
        const acc = await az<AzAccountShow>(['account', 'show'], { configDir, timeoutMs: 15_000 });
        if (!acc) return null;
        return { tenantId: acc.tenantId, subscriptionId: acc.id, name: acc.name };
      } catch (err) {
        if (err instanceof AzError && (err.code === 'NOT_LOGGED_IN' || err.code === 'CLI_ERROR')) {
          return null;
        }
        throw err;
      }
    },
  };
}
