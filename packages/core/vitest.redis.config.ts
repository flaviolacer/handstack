import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/redis-streams.integration.test.ts'],
    testTimeout: 30_000,
  },
});
