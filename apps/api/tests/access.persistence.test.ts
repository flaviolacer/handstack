import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { AccessRuntimeService } from '../src/access/access-runtime.service.js';

describe('durable access runtime SQLite round-trip', () => {
  let database: DatabaseService | undefined;

  afterEach(async () => {
    await database?.onModuleDestroy();
    database = undefined;
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
  });

  it('persists requests and grants in the canonical tenant repositories', async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    database = new DatabaseService();
    await database.onModuleInit();
    const runtime = new AccessRuntimeService(database);
    const request = await runtime.access.submit({
      organizationId: 'org-persist',
      requesterId: 'user',
      resource: 'db',
      reason: 'incident',
      duration: '1h',
    });
    const grant = await runtime.access.approve('org-persist', request.id, 'admin');
    const secondRuntime = new AccessRuntimeService(database);
    await expect(secondRuntime.access.list('org-persist')).resolves.toHaveLength(1);
    await expect(secondRuntime.access.active('org-persist', 'user', 'db')).resolves.toMatchObject([
      { id: grant.id },
    ]);
  });
});
