import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * API integration tests: the real Express app + Postgres + Redis (no Azure).
 *
 *   INTEGRATION_DATABASE_URL=postgresql://…  INTEGRATION_REDIS_URL=redis://… \
 *     pnpm --filter @cloudops/api test:integration
 *
 * The database must be migrated first (`pnpm --filter @cloudops/api db:migrate`).
 * CI runs this against throwaway Postgres/Redis service containers.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: process.env.INTEGRATION_DATABASE_URL ?? 'postgresql://cloudops:cloudops@localhost:5432/cloudops_test?schema=public',
      REDIS_URL: process.env.INTEGRATION_REDIS_URL ?? 'redis://localhost:6379/15',
      JWT_ACCESS_SECRET: 'integration-access-secret-0123456789abcdef',
      JWT_REFRESH_SECRET: 'integration-refresh-secret-0123456789abcdef',
      // Never touch a real credential store or Azure from tests.
      CLOUDOPS_DATA_DIR: mkdtempSync(join(tmpdir(), 'cloudops-it-')),
      AZURE_ALLOW_WRITE: 'false',
      AZURE_ORGS: '',
      RATE_LIMIT_ENABLED: 'true',
    },
  },
});
