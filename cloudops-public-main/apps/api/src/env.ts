import './infra/load-env.js'; // must run before the environment is read below
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '@cloudops/kernel';

/** This build's version (apps/api/package.json) — independent of how the process was launched. */
export const API_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/** The documented first-boot admin password (.env.example / docker-compose default). */
export const DEFAULT_SEED_PASSWORD = 'ChangeMe123!';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(3000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  // Log verbosity (error|warn|info|debug). Default: info in production, debug otherwise.
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).optional(),
  // Express `trust proxy` — set when running behind a reverse proxy so client
  // IPs (rate limiting, audit) come from X-Forwarded-For. `true`, a hop count,
  // or a comma list of trusted subnets. Default: off (direct connections).
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v): boolean | number | string => {
      if (v === undefined || v === '' || v === 'false' || v === '0') return false;
      if (v === 'true') return true;
      return /^\d+$/.test(v) ? Number(v) : v;
    }),
  // Abuse protection on login / refresh / expensive endpoints (Redis-backed).
  /** Enables GET /metrics (Prometheus); scrapes send it as a Bearer token. Unset = no endpoint. */
  METRICS_TOKEN: z
    .string()
    .optional()
    .refine((v) => !v || v.length >= 16, 'METRICS_TOKEN must be at least 16 characters')
    .transform((v) => v || undefined),
  RATE_LIMIT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://redis:6379'),

  JWT_ACCESS_SECRET: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@cloudops.local'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default(DEFAULT_SEED_PASSWORD),

  CREDENTIAL_PROVIDER: z.string().default('azure-cli'),
  AZURE_CONFIG_DIR: z.string().optional(),
  // Tag name to read each resource's owner from during sync (default `Owner`).
  AZURE_OWNER_TAG: z.string().default('Owner'),
  // Master switch for write-back to Azure (tag writes today). Default ON.
  // Set to 'false'/'0' to make the platform strictly read-only.
  AZURE_ALLOW_WRITE: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),

  // Remediation: may the person who requested a medium/high-risk change also
  // approve it? Default no (four eyes). Set true for single-operator installs.
  REMEDIATION_SELF_APPROVAL: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  // FinOps: window (days) each cost sync pulls (kept wide so custom ranges +
  // period-over-period comparison work); and optional daily auto-sync.
  FINOPS_WINDOW_DAYS: z.coerce.number().int().positive().default(90),
  FINOPS_DAILY_SYNC: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Reporting currency: every cost is stored and shown in it. Cost Azure bills
  // in another currency is converted during the cost sync (see modules/finops/fx.ts).
  COST_CURRENCY: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO currency code'))
    .default('INR'),
  // Optional pinned rates, e.g. `USD=95.5,EUR=101` (1 unit of that currency in
  // COST_CURRENCY). Unset: Microsoft's rate from the Azure Retail Prices API.
  COST_FX_RATES: z.string().optional(),

  // Local data directory — home of the encrypted credential store (provider
  // credentials entered in the Providers page). Never Postgres.
  // Default: <home>/.cloudops (container: set it to a mounted volume).
  CLOUDOPS_DATA_DIR: z.string().optional(),
  // Optional externally-supplied 32-byte key (hex or base64) for that store.
  // When unset, a key file is generated next to it on first write.
  CREDENTIAL_STORE_KEY: z.string().optional(),

  // Multi-org (multi-tenant) service principals for fully containerized sync.
  // JSON array; extensible to any number of orgs. Never stored in Postgres.
  // Optional — orgs can instead be added in the UI (Providers page).
  AZURE_ORGS: z.string().optional(),
  // Single-SP fallback (one org).
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),
  AZURE_ORG_NAME: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

/** Values shipped in .env.example / docker-compose — fine on a laptop, never in production. */
const KNOWN_DEV_SECRETS = new Set(['dev-access', 'dev-refresh', 'dev-access-secret-change-me', 'dev-refresh-secret-change-me']);

/**
 * Security posture of the configuration. `fatal` issues stop the API from
 * booting in production (guessable token-signing secrets); `warnings` are only
 * logged. Outside production everything is a warning, so local development
 * keeps working with the shipped defaults.
 */
export function configSecurityIssues(
  c: Pick<AppConfig, 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET' | 'SEED_ADMIN_PASSWORD'> & Partial<Pick<AppConfig, 'TRUST_PROXY'>>,
): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    const v = c[key];
    if (KNOWN_DEV_SECRETS.has(v) || /change-?me/i.test(v)) fatal.push(`${key} is a well-known default value`);
    else if (v.length < 32) fatal.push(`${key} is shorter than 32 characters`);
  }
  if (c.JWT_ACCESS_SECRET === c.JWT_REFRESH_SECRET) {
    fatal.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  }
  const warnings: string[] = [];
  if (c.SEED_ADMIN_PASSWORD === DEFAULT_SEED_PASSWORD) {
    warnings.push('SEED_ADMIN_PASSWORD is the documented default — change the admin password after first login');
  }
  if (c.TRUST_PROXY === true) {
    warnings.push(
      'TRUST_PROXY=true trusts every X-Forwarded-For hop — clients can spoof their IP to dodge rate limits; set the proxy hop count (e.g. 1) instead',
    );
  }
  return { fatal, warnings };
}

export const config: AppConfig = loadConfig((env) => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  if (parsed.data.NODE_ENV === 'production') {
    const issues = configSecurityIssues(parsed.data).fatal;
    if (issues.length) {
      throw new Error(
        `Refusing to start in production with insecure configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}\n` +
          'Generate secrets with e.g. `openssl rand -base64 48`.',
      );
    }
  }
  return parsed.data;
});

export const corsOrigins = config.CORS_ORIGIN.split(',').map((s) => s.trim());

/** Directory for local platform state that must not live in Postgres. */
export const dataDir: string = config.CLOUDOPS_DATA_DIR ?? join(homedir(), '.cloudops');

/** Encrypted document holding provider credentials entered in the UI. */
export const credentialStorePath: string = join(dataDir, 'credentials', 'provider-accounts.enc.json');

/** An Azure org = one Entra tenant + its service principal. */
export interface AzureOrgConfig {
  name: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

const azureOrgSchema = z.object({
  name: z.string().min(1),
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

/**
 * Azure orgs declared in the ENVIRONMENT. These are read-only in the UI — the
 * `.env` file that declares them is their source of truth. Orgs added in the
 * Providers page come from the encrypted credential store instead and are
 * merged with these at runtime (see ProviderAccountsService).
 *
 *  1) AZURE_ORGS (JSON array) — multi-org container mode.
 *  2) AZURE_CLIENT_ID/TENANT_ID/CLIENT_SECRET — single-SP mode.
 *  3) [] — nothing from env; the store (or host `az login`) provides the orgs.
 */
export const azureOrgs: AzureOrgConfig[] = (() => {
  const raw = config.AZURE_ORGS?.trim();
  if (raw) {
    return z.array(azureOrgSchema).parse(JSON.parse(raw));
  }
  if (config.AZURE_CLIENT_ID && config.AZURE_TENANT_ID && config.AZURE_CLIENT_SECRET) {
    return [
      {
        name: config.AZURE_ORG_NAME ?? 'Default',
        tenantId: config.AZURE_TENANT_ID,
        clientId: config.AZURE_CLIENT_ID,
        clientSecret: config.AZURE_CLIENT_SECRET,
      },
    ];
  }
  return [];
})();
