import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/mongodb-portable.integration.test.ts'] } });
