import { defineConfig } from 'vitest/config';

/**
 * The api validates its environment at import time (env.ts fails fast), so unit
 * tests that reach any module importing the config need these placeholders.
 * They are throwaway values — nothing here connects to a real database.
 */
export default defineConfig({
  test: {
    // Unit tests only — the API integration suite (test/) has its own config.
    include: ['src/**/*.test.ts', 'prisma/**/*.test.ts'],
    env: {
      DATABASE_URL: 'postgresql://cloudops:cloudops@localhost:5432/cloudops_test?schema=public',
      JWT_ACCESS_SECRET: 'test-access-secret',
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      LOG_LEVEL: 'error',
    },
  },
});
