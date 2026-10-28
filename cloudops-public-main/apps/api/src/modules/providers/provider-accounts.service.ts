import { randomUUID } from 'node:crypto';
import type {
  CreateProviderAccountRequest,
  ProviderAccountDto,
  ProviderAccountsStatusDto,
  UpdateProviderAccountRequest,
} from '@cloudops/core';
import type { EncryptedJsonStore } from '@cloudops/credentials';
import type { Logger } from '@cloudops/kernel';
import { AppError } from '../../http/errors.js';

/** One org as held in the encrypted store. The secret never leaves the server. */
export interface StoredProviderAccount {
  id: string;
  providerKey: string;
  name: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Versioned document written to the encrypted store. */
export interface ProviderAccountsDocument {
  v: 1;
  accounts: StoredProviderAccount[];
}

/** Env-declared org (AZURE_ORGS / single-SP vars), read-only in the UI. */
export interface EnvProviderAccount {
  name: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/** Shape the provider plugins consume - identical for both sources. */
export interface ResolvedProviderAccount {
  name: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Provider accounts (organizations) - the credentials the platform syncs with.
 *
 * Two sources are merged, and the merge order is the whole design:
 *  - the encrypted store, written from the Providers page, wins; then
 *  - environment orgs (AZURE_ORGS), for setups that still declare them there.
 *
 * A tenant configured in both places is taken from the store, because that is
 * the copy the operator most recently edited - otherwise a stale .env would
 * silently shadow a rotated secret entered in the UI.
 *
 * The decrypted accounts are cached in memory so provider plugins can read them
 * synchronously on every call; nothing here ever touches Postgres.
 */
export class ProviderAccountsService {
  private accounts: StoredProviderAccount[] = [];
  private loaded = false;

  constructor(
    private readonly store: EncryptedJsonStore<ProviderAccountsDocument>,
    private readonly envAccounts: EnvProviderAccount[],
    private readonly logger: Logger,
  ) {}

  /** Decrypt the store once at boot. A missing store simply means "none yet". */
  async init(): Promise<void> {
    const doc = await this.store.read();
    this.accounts = doc?.accounts ?? [];
    this.loaded = true;
    if (this.accounts.length > 0) {
      this.logger.info(`loaded ${this.accounts.length} provider account(s) from the store`, {
        path: this.store.path,
      });
    }
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('ProviderAccountsService used before init()');
  }

  private async persist(): Promise<void> {
    await this.store.write({ v: 1, accounts: this.accounts });
  }

  private envFor(providerKey: string): EnvProviderAccount[] {
    // Only Azure declares orgs in the environment today; future providers add
    // their own env source here (or go straight to the store).
    return providerKey === 'azure' ? this.envAccounts : [];
  }

  /**
   * The orgs a provider should sync: enabled stored accounts first, then env
   * accounts whose tenant is not already covered by the store.
   */
  resolve(providerKey: string): ResolvedProviderAccount[] {
    this.assertLoaded();
    const stored = this.accounts.filter((a) => a.providerKey === providerKey && a.enabled);
    const claimed = new Set(stored.map((a) => a.tenantId.toLowerCase()));
    const fromEnv = this.envFor(providerKey).filter((a) => !claimed.has(a.tenantId.toLowerCase()));
    return [...stored, ...fromEnv].map((a) => ({
      name: a.name,
      tenantId: a.tenantId,
      clientId: a.clientId,
      clientSecret: a.clientSecret,
    }));
  }

  /** Everything the Providers page shows - both sources, secrets redacted. */
  list(providerKey: string): ProviderAccountDto[] {
    this.assertLoaded();
    const stored = this.accounts
      .filter((a) => a.providerKey === providerKey)
      .map<ProviderAccountDto>((a) => ({
        id: a.id,
        providerKey: a.providerKey,
        name: a.name,
        tenantId: a.tenantId,
        clientId: a.clientId,
        secretSet: a.clientSecret.length > 0,
        enabled: a.enabled,
        source: 'store',
        editable: true,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      }));

    const claimed = new Set(stored.map((a) => a.tenantId.toLowerCase()));
    const fromEnv = this.envFor(providerKey).map<ProviderAccountDto>((a, i) => ({
      id: `env:${i}`,
      providerKey,
      name: a.name,
      tenantId: a.tenantId,
      clientId: a.clientId,
      secretSet: a.clientSecret.length > 0,
      // An env org whose tenant is also in the store is shadowed by it.
      enabled: !claimed.has(a.tenantId.toLowerCase()),
      source: 'env',
      editable: false,
      createdAt: null,
      updatedAt: null,
    }));

    return [...stored, ...fromEnv];
  }

  status(providerKey: string): ProviderAccountsStatusDto {
    this.assertLoaded();
    return {
      providerKey,
      storeCount: this.accounts.filter((a) => a.providerKey === providerKey).length,
      envCount: this.envFor(providerKey).length,
      hostMode: this.resolve(providerKey).length === 0,
      externalKey: this.store.keyIsExternal,
    };
  }

  async create(providerKey: string, input: CreateProviderAccountRequest): Promise<ProviderAccountDto> {
    this.assertLoaded();
    const duplicate = this.accounts.find(
      (a) =>
        a.providerKey === providerKey &&
        a.tenantId.toLowerCase() === input.tenantId.trim().toLowerCase() &&
        a.clientId.toLowerCase() === input.clientId.trim().toLowerCase(),
    );
    if (duplicate) {
      throw AppError.conflict(`"${duplicate.name}" already uses this tenant and client id`);
    }

    const now = new Date().toISOString();
    const created: StoredProviderAccount = {
      id: randomUUID(),
      providerKey,
      name: input.name.trim(),
      tenantId: input.tenantId.trim(),
      clientId: input.clientId.trim(),
      clientSecret: input.clientSecret,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    };
    this.accounts.push(created);
    await this.persist();
    this.logger.info('provider account added', { providerKey, name: created.name });
    return this.byId(providerKey, created.id);
  }

  async update(
    providerKey: string,
    id: string,
    input: UpdateProviderAccountRequest,
  ): Promise<ProviderAccountDto> {
    this.assertLoaded();
    const account = this.mutable(providerKey, id);
    if (input.name !== undefined) account.name = input.name.trim();
    if (input.tenantId !== undefined) account.tenantId = input.tenantId.trim();
    if (input.clientId !== undefined) account.clientId = input.clientId.trim();
    // An omitted secret keeps the stored one - the UI never round-trips it.
    if (input.clientSecret !== undefined) account.clientSecret = input.clientSecret;
    if (input.enabled !== undefined) account.enabled = input.enabled;
    account.updatedAt = new Date().toISOString();
    await this.persist();
    this.logger.info('provider account updated', { providerKey, name: account.name });
    return this.byId(providerKey, id);
  }

  async remove(providerKey: string, id: string): Promise<void> {
    this.assertLoaded();
    const account = this.mutable(providerKey, id);
    this.accounts = this.accounts.filter((a) => a !== account);
    await this.persist();
    this.logger.info('provider account removed', { providerKey, name: account.name });
  }

  /**
   * Server-side only: the full credentials of one account, for a connectivity
   * test. Works for env accounts too, so every row on the page has a Test
   * button. Never reachable from a response body.
   */
  credentialsFor(providerKey: string, id: string): ResolvedProviderAccount {
    this.assertLoaded();
    if (id.startsWith('env:')) {
      const account = this.envFor(providerKey)[Number(id.slice('env:'.length))];
      if (!account) throw AppError.notFound('Provider account not found');
      return { ...account };
    }
    const account = this.accounts.find((a) => a.id === id && a.providerKey === providerKey);
    if (!account) throw AppError.notFound('Provider account not found');
    return {
      name: account.name,
      tenantId: account.tenantId,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
    };
  }

  /** Locate a stored account, rejecting ids that belong to the env source. */
  private mutable(providerKey: string, id: string): StoredProviderAccount {
    if (id.startsWith('env:')) {
      throw AppError.badRequest(
        'This organization comes from the environment (AZURE_ORGS). Edit it in your .env file, or remove it there and add it here instead.',
      );
    }
    const account = this.accounts.find((a) => a.id === id && a.providerKey === providerKey);
    if (!account) throw AppError.notFound('Provider account not found');
    return account;
  }

  private byId(providerKey: string, id: string): ProviderAccountDto {
    const dto = this.list(providerKey).find((a) => a.id === id);
    if (!dto) throw AppError.notFound('Provider account not found');
    return dto;
  }
}
