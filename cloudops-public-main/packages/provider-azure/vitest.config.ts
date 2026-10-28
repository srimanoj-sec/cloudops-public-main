import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Provider tests touch the real filesystem (per-org CLI profile dirs); give
    // them headroom when the whole monorepo's suites run in parallel.
    testTimeout: 15_000,
  },
});
