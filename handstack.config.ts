import { defineConfig } from '@handstack/config';

export default defineConfig({
  deployment: {
    profile: process.env.HANDSTACK_DEPLOYMENT_PROFILE === 'distributed' ? 'distributed' : 'compact',
  },
  database: {
    adapter: process.env.HANDSTACK_DATABASE_ADAPTER ?? 'sqlite',
    url: process.env.HANDSTACK_DATABASE_URL ?? 'file:./handstack.db',
  },
  telemetry: { enabled: false },
});
