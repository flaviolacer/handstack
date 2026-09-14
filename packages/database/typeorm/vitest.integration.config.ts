import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/postgresql.integration.test.ts'] } });
