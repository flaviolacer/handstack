import { defineConfig } from '@handstack/config';

export default defineConfig({
  deployment: { profile: 'compact' },
  database: {
    adapter: 'sqlite',
    url: process.env.HANDSTACK_DATABASE_URL ?? 'file:./handstack.db',
  },
  telemetry: { enabled: false },
});
