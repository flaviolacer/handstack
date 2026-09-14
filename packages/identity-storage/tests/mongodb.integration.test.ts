import { MongoAdapter } from '@handstack/database';
import type { User } from '@handstack/identity';
import { IdentityStorage } from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('MongoDB identity storage', () => {
  it('persists scoped identities and rolls transactions back on a replica set', async () => {
    const url = process.env.HANDSTACK_TEST_MONGODB_URL;
    if (url === undefined) throw new Error('HANDSTACK_TEST_MONGODB_URL is required');
    const adapter = await new MongoAdapter(url, 'handstack_identity_storage').initialize();
    const timestamp = new Date('2026-09-01T12:00:00.000Z');
    const user: User = {
      id: '00000000-0000-4000-8000-000000000001',
      tenantId: 'organization-a',
      organizationId: 'organization-a',
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      type: 'USER',
      status: 'ACTIVE',
      displayName: 'Mongo User',
      username: 'mongo.user',
      normalizedUsername: 'mongo.user',
    };
    try {
      const storage = new IdentityStorage(adapter);
      await storage.forOrganization('organization-a').users.insert(user);
      await expect(
        storage.forOrganization('organization-a').users.findById(user.id),
      ).resolves.toMatchObject({
        id: user.id,
        organizationId: 'organization-a',
      });
      await expect(
        storage.run('organization-a', async (stores) => {
          await stores.users.insert({
            ...user,
            id: '00000000-0000-4000-8000-000000000002',
          });
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      await expect(
        storage
          .forOrganization('organization-a')
          .users.findById('00000000-0000-4000-8000-000000000002'),
      ).resolves.toBeUndefined();
    } finally {
      await adapter.nativeDatabase().dropDatabase();
      await adapter.close();
    }
  });
});
