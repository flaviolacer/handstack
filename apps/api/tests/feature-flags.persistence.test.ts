import { describe, expect, it } from 'vitest';
import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { OperationsRuntimeService } from '../src/operations/operations-runtime.service.js';
import type { DatabaseService } from '../src/database/database.service.js';

describe('feature flag persistence', () => {
  it('retains global, organization and user overrides after recreating the runtime', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const database = { adapter } as DatabaseService;
      const first = new OperationsRuntimeService(undefined, database);
      await first.setFeatureFlag({ key: 'new-ui', scope: 'global', enabled: true });
      await first.setFeatureFlag({
        key: 'new-ui',
        scope: 'organization',
        organizationId: 'org-a',
        enabled: false,
      });
      await first.setFeatureFlag({
        key: 'new-ui',
        scope: 'user',
        organizationId: 'org-a',
        userId: 'user-a',
        enabled: true,
      });

      const second = new OperationsRuntimeService(undefined, database);
      await expect(second.listFeatureFlags('org-a', 'user-a')).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'new-ui', scope: 'global', enabled: true }),
          expect.objectContaining({ key: 'new-ui', scope: 'organization', enabled: false }),
          expect.objectContaining({ key: 'new-ui', scope: 'user', enabled: true }),
        ]),
      );
      await expect(second.listFeatureFlags('org-b', 'user-b')).resolves.toEqual([
        expect.objectContaining({ key: 'new-ui', scope: 'global', enabled: true }),
      ]);
    } finally {
      await adapter.close();
    }
  });
});
