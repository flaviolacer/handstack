import { repositoryName, uuidV7 } from '@handstack/domain';
import {
  createPortableSink,
  createPortableSource,
  exportPortable,
  importPortable,
  MongoAdapter,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('MongoDB portable persistence', () => {
  it('round-trips through durable staging on a replica set', async () => {
    const url = process.env.HANDSTACK_TEST_MONGODB_URL;
    if (url === undefined) throw new Error('HANDSTACK_TEST_MONGODB_URL is required');
    const source = await new MongoAdapter(url, 'handstack_portable_source').initialize();
    const target = await new MongoAdapter(url, 'handstack_portable_target').initialize();
    const id = uuidV7();
    const timestamp = new Date('2026-09-01T00:00:00.000Z');
    try {
      await source
        .repository<{
          readonly id: string;
          readonly tenantId: string;
          readonly version: number;
          readonly createdAt: Date;
          readonly updatedAt: Date;
          readonly name: string;
        }>(repositoryName('users'))
        .insert({
          id,
          tenantId: 'tenant-a',
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          name: 'Ana',
        });
      await importPortable(
        exportPortable(createPortableSource(source), {
          exportId: 'mongo-roundtrip',
          signingKey: 'test-portable-signing-key',
        }),
        createPortableSink(target),
        'mongo-roundtrip',
        'test-portable-signing-key',
      );
      const restored = await target
        .repository<{
          readonly id: string;
          readonly tenantId: string;
          readonly version: number;
          readonly createdAt: Date;
          readonly updatedAt: Date;
          readonly name: string;
        }>(repositoryName('users'))
        .findById('tenant-a', id);
      expect(restored).toMatchObject({ id, tenantId: 'tenant-a', name: 'Ana' });
    } finally {
      await source.nativeDatabase().dropDatabase();
      await target.nativeDatabase().dropDatabase();
      await source.close();
      await target.close();
    }
  });
});
