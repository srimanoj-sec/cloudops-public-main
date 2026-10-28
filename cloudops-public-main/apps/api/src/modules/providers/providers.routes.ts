import { Router, type RequestHandler } from 'express';
import {
  createProviderAccountSchema,
  updateProviderAccountSchema,
  type AccountConnResult,
} from '@cloudops/core';
import type { ProviderRegistry, CloudProvider, ProviderContext } from '@cloudops/provider-sdk';
import type { CredentialChain } from '@cloudops/credentials';
import { asyncHandler } from '../../http/async.js';
import { parse } from '../../http/validate.js';
import { AppError } from '../../http/errors.js';
import type { Prisma } from '../../infra/prisma.js';
import { byUser, type RateLimiterFactory } from '../../http/rate-limit.js';
import { actorOf, type AuditService } from '../audit/audit.service.js';
import type { ProviderAccountsService } from './provider-accounts.service.js';

/**
 * Providers module: lists registered provider plugins, manages the accounts
 * (organizations) each one syncs, and tests connectivity.
 *
 * Account credentials are entered here rather than in `.env` — they are held in
 * the local encrypted credential store, never in Postgres, and take effect
 * without restarting the API.
 */
export function createProvidersRouter(
  registry: ProviderRegistry,
  credentials: CredentialChain,
  prisma: Prisma,
  accounts: ProviderAccountsService,
  requireAdmin: RequestHandler,
  audit: AuditService,
  limit: RateLimiterFactory,
): Router {
  const router = Router();
  // Connectivity tests run `az login` against Azure — cheap to click, not to run.
  const testLimit = limit({ name: 'provider-test', windowMs: 60_000, max: 10, key: byUser });

  /**
   * A context for credential tests. Deliberately does NOT go through the
   * credential chain: the whole point is to validate a service principal on a
   * fresh install, where no source can resolve yet. The credentials under test
   * come from the request (or the store), not from this context.
   */
  const testContext = (provider: CloudProvider): ProviderContext => ({
    credential: { source: 'env', metadata: { providerKey: provider.key } },
    log: () => {},
  });

  function accountTester(key: string): {
    provider: CloudProvider;
    test: (creds: Record<string, string>) => Promise<AccountConnResult>;
  } {
    const provider = registry.get(key);
    const testAccount = provider.testAccountCredentials?.bind(provider);
    if (!testAccount) {
      throw AppError.badRequest(
        `${provider.displayName} does not support per-account credential tests`,
      );
    }
    return { provider, test: (creds) => testAccount(creds, testContext(provider)) };
  }

  function validateProviderAccount(key: string, input: { tenantId: string; clientId: string }) {
    if (
      key === 'azure' &&
      (!/^[0-9a-fA-F-]{36}$/.test(input.tenantId) || !/^[0-9a-fA-F-]{36}$/.test(input.clientId))
    ) {
      throw AppError.badRequest('Azure directory and application IDs must be GUIDs.');
    }
  }

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const records = await prisma.provider.findMany({ orderBy: { displayName: 'asc' } });
      const live = registry.list();
      res.json(
        live.map((p) => ({
          key: p.key,
          displayName: p.displayName,
          capabilities: p.capabilities,
          registered: records.some((r) => r.key === p.key),
          accountCount: accounts.list(p.key).length,
        })),
      );
    }),
  );

  router.get(
    '/:key/test-connection',
    testLimit,
    asyncHandler(async (req, res) => {
      const provider = registry.get(req.params.key as string);
      const credential = await credentials.resolve({ providerKey: provider.key });
      const result = await provider.testConnection({
        credential,
        log: () => {},
      });
      res.json(result);
    }),
  );

  // Per-account/organization connectivity — validates every configured service
  // principal's read access. Falls back to a single testConnection for providers
  // that don't manage multiple accounts.
  router.get(
    '/:key/test',
    testLimit,
    asyncHandler(async (req, res) => {
      const provider = registry.get(req.params.key as string);
      const credential = await credentials.resolve({ providerKey: provider.key });
      const ctx = { credential, log: () => {} };
      const results = provider.testConnections
        ? await provider.testConnections(ctx)
        : await provider
            .testConnection(ctx)
            .then((r) => [{ account: provider.displayName, ok: r.ok, message: r.message }]);
      res.json({ ok: results.every((a) => a.ok), accounts: results });
    }),
  );

  // ── Accounts (organizations) ──────────────────────────────────────

  router.get(
    '/:key/accounts',
    asyncHandler(async (req, res) => {
      const provider = registry.get(req.params.key as string);
      res.json(accounts.list(provider.key));
    }),
  );

  /** Where credentials are coming from — drives the Providers page banner. */
  router.get(
    '/:key/accounts/status',
    asyncHandler(async (req, res) => {
      const provider = registry.get(req.params.key as string);
      res.json(accounts.status(provider.key));
    }),
  );

  /**
   * Validate credentials typed into the form BEFORE they are saved. Registered
   * ahead of `/:id` so "test" is never read as an account id.
   */
  router.post(
    '/:key/accounts/test',
    requireAdmin,
    testLimit,
    asyncHandler(async (req, res) => {
      const { test } = accountTester(req.params.key as string);
      const input = parse(createProviderAccountSchema, req.body);
      validateProviderAccount(req.params.key as string, input);
      res.json(
        await test({
          name: input.name,
          tenantId: input.tenantId,
          clientId: input.clientId,
          clientSecret: input.clientSecret,
        }),
      );
    }),
  );

  /** Validate one already-saved account, using the secret held in the store. */
  router.post(
    '/:key/accounts/:id/test',
    requireAdmin,
    testLimit,
    asyncHandler(async (req, res) => {
      const { provider, test } = accountTester(req.params.key as string);
      const account = accounts.credentialsFor(provider.key, req.params.id as string);
      res.json(await test({ ...account }));
    }),
  );

  router.post(
    '/:key/accounts',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const provider = registry.get(req.params.key as string);
      const input = parse(createProviderAccountSchema, req.body);
      validateProviderAccount(provider.key, input);
      const created = await accounts.create(provider.key, input);
      await audit.record({
        action: 'provider.account.create',
        entity: 'providerAccount',
        entityId: created.id,
        actor: actorOf(req),
        // Identifiers only — the secret never enters the audit trail.
        metadata: {
          provider: provider.key,
          name: input.name,
          tenantId: input.tenantId,
          clientId: input.clientId,
        },
      });
      res.status(201).json(created);
    }),
  );

  router.patch(
    '/:key/accounts/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const provider = registry.get(req.params.key as string);
      const input = parse(updateProviderAccountSchema, req.body);
      validateProviderAccount(provider.key, {
        tenantId:
          input.tenantId ?? accounts.credentialsFor(provider.key, req.params.id as string).tenantId,
        clientId:
          input.clientId ?? accounts.credentialsFor(provider.key, req.params.id as string).clientId,
      });
      const updated = await accounts.update(provider.key, req.params.id as string, input);
      const { clientSecret, ...changed } = input;
      await audit.record({
        action: 'provider.account.update',
        entity: 'providerAccount',
        entityId: updated.id,
        actor: actorOf(req),
        metadata: {
          provider: provider.key,
          name: updated.name,
          changed: Object.keys(changed),
          secretRotated: Boolean(clientSecret),
        },
      });
      res.json(updated);
    }),
  );

  router.delete(
    '/:key/accounts/:id',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const provider = registry.get(req.params.key as string);
      const id = req.params.id as string;
      const existing = accounts.list(provider.key).find((a) => a.id === id);
      await accounts.remove(provider.key, id);
      await audit.record({
        action: 'provider.account.delete',
        entity: 'providerAccount',
        entityId: id,
        actor: actorOf(req),
        metadata: { provider: provider.key, name: existing?.name, tenantId: existing?.tenantId },
      });
      res.status(204).end();
    }),
  );

  return router;
}
