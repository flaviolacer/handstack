import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/mongodb.integration.test.ts', 'tests/failover.integration.test.ts'] },
});
