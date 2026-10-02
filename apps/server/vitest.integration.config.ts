import { defineConfig } from 'vitest/config';

/**
 * Integration tier: real Postgres (pgvector) and Redis, the way production runs. Needs INTEGRATION_DATABASE_URL and
 * INTEGRATION_REDIS_URL (see test-integration/helpers.ts); without them every test is skipped. Files run one at a
 * time because they share the Redis database.
 */
export default defineConfig({
  test: {
    include: ['test-integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
