import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/object-storage.integration.test.ts'],
    testTimeout: 30_000,
  },
});
