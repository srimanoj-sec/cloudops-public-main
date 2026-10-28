/**
 * @cloudops/credentials — credential resolution abstraction.
 *
 * NON-NEGOTIABLE PRINCIPLE: secrets are NEVER stored in PostgreSQL. Cloud auth
 * is resolved at runtime from an ordered chain of sources. The database holds
 * only non-secret connection metadata (tenant id, subscription id, names).
 *
 * Resolution order: azure-cli -> windows-credential-manager -> key-vault -> env.
 * Each source implements the `CredentialProvider` contract, so new secret
 * backends plug in without touching modules.
 */

/** A resolved, in-memory credential context. Never persisted. */
export interface CredentialContext {
  /** Which source satisfied the request. */
  source: CredentialSourceKind;
  /** Non-secret identity metadata safe to log / store. */
  metadata: Record<string, string>;
  /** Opaque secret material (token, password). Present only in memory. */
  secret?: string;
}

export type CredentialSourceKind =
  | 'azure-cli'
  | 'windows-credential-manager'
  | 'key-vault'
  | 'env';

export interface CredentialRequest {
  providerKey: string; // 'azure'
  /** Optional scope hint, e.g. a tenant or subscription id. */
  scope?: string;
}

export interface CredentialProvider {
  readonly kind: CredentialSourceKind;
  /** Cheap check whether this source can currently satisfy requests. */
  isAvailable(): Promise<boolean>;
  resolve(request: CredentialRequest): Promise<CredentialContext>;
}

/**
 * Azure CLI credential provider — the primary source. It does NOT extract or
 * store tokens; it simply confirms an `az login` session exists and returns
 * non-secret identity metadata. Actual auth is delegated to `az` at call time
 * by the Azure plugin (which shells out reusing the same session).
 */
export interface AzureCliProbe {
  /** Returns the active account metadata, or null if not logged in. */
  accountShow(): Promise<{ tenantId: string; subscriptionId: string; name: string } | null>;
}

export class AzureCliCredentialProvider implements CredentialProvider {
  readonly kind = 'azure-cli' as const;

  constructor(private readonly probe: AzureCliProbe) {}

  async isAvailable(): Promise<boolean> {
    return (await this.probe.accountShow()) !== null;
  }

  async resolve(request: CredentialRequest): Promise<CredentialContext> {
    const account = await this.probe.accountShow();
    if (!account) {
      throw new Error(
        'No active Azure CLI session. Run `az login` on the host (its ~/.azure is mounted read-only).',
      );
    }
    return {
      source: this.kind,
      metadata: {
        providerKey: request.providerKey,
        tenantId: account.tenantId,
        subscriptionId: request.scope ?? account.subscriptionId,
        accountName: account.name,
      },
      // No secret returned — `az` holds the session; we never copy the token.
    };
  }
}

/** Env-var fallback (e.g. service principal via env). Secret stays in memory. */
export class EnvCredentialProvider implements CredentialProvider {
  readonly kind = 'env' as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.env.AZURE_CLIENT_ID && this.env.AZURE_TENANT_ID);
  }

  async resolve(request: CredentialRequest): Promise<CredentialContext> {
    const { AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET } = this.env;
    if (!AZURE_CLIENT_ID || !AZURE_TENANT_ID) {
      throw new Error('Env credential source not configured.');
    }
    return {
      source: this.kind,
      metadata: {
        providerKey: request.providerKey,
        tenantId: AZURE_TENANT_ID,
        clientId: AZURE_CLIENT_ID,
        subscriptionId: request.scope ?? '',
      },
      secret: AZURE_CLIENT_SECRET,
    };
  }
}

/**
 * Credential chain — tries sources in order, returning the first available.
 * Placeholders for windows-credential-manager and key-vault sources are added
 * in later phases; the chain contract does not change.
 */
export class CredentialChain {
  constructor(private readonly providers: CredentialProvider[]) {}

  async resolve(request: CredentialRequest): Promise<CredentialContext> {
    const errors: string[] = [];
    for (const provider of this.providers) {
      try {
        if (await provider.isAvailable()) {
          return await provider.resolve(request);
        }
      } catch (err) {
        errors.push(`${provider.kind}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(
      `No credential source could satisfy the request for "${request.providerKey}".` +
        (errors.length ? `\n${errors.join('\n')}` : ''),
    );
  }
}

/**
 * Local encrypted vault (single-user offline deployments). Credentials entered
 * in the UI live here — on disk, outside PostgreSQL — and are loaded into
 * memory at boot exactly like the env-var source.
 */
export * from './secret-store.js';
