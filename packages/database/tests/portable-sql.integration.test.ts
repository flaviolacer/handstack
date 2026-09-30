import { TypeOrmAdapter } from '@handstack/database-typeorm';
import { repositoryName, uuidV7 } from '@handstack/domain';
import { describe, expect, it } from 'vitest';
import {
  createPortableSink,
  createPortableSource,
  exportPortable,
  importPortable,
  type PortableFrame,
  verifyPortable,
} from '../src/index.js';

async function* replayFrames(frames: readonly PortableFrame[]) {
  await Promise.resolve();
  yield* frames;
}

describe('SQL portable backup and restore', () => {
  it('round-trips a signed tenant-scoped export through the TypeORM adapter', async () => {
    const adapterName = process.env.HANDSTACK_TEST_SQL_ADAPTER;
    const url = process.env.HANDSTACK_TEST_SQL_URL;
    if (!['postgresql', 'mysql', 'mariadb', 'sqlserver'].includes(adapterName ?? '')) {
      throw new Error(
        'HANDSTACK_TEST_SQL_ADAPTER must be postgresql, mysql, mariadb, or sqlserver',
      );
    }
    if (url === undefined) throw new Error('HANDSTACK_TEST_SQL_URL is required');

    const source = await new TypeOrmAdapter({
      adapter: adapterName as 'postgresql' | 'mysql' | 'mariadb' | 'sqlserver',
      url,
    }).initialize();
    const target = await new TypeOrmAdapter({
      adapter: adapterName as 'postgresql' | 'mysql' | 'mariadb' | 'sqlserver',
      url,
    }).initialize();
    const tenantId = `portable-${uuidV7()}`;
    const id = uuidV7();
    const repository = source.repository<{
      readonly id: string;
      readonly tenantId: string;
      readonly version: number;
      readonly createdAt: Date;
      readonly updatedAt: Date;
      readonly name: string;
    }>(repositoryName('users'));
    const createdAt = new Date('2026-09-29T12:00:00.000Z');
    const signingKey = 'sql-portable-signing-key-2026';
    const exportId = `sql-${uuidV7()}`;

    try {
      await repository.insert({
        id,
        tenantId,
        version: 1,
        createdAt,
        updatedAt: createdAt,
        name: 'Ana',
      });
      const frames = exportPortable(createPortableSource(source), {
        exportId,
        tenantId,
        signingKey,
      });
      const buffered: PortableFrame[] = [];
      for await (const frame of frames) buffered.push(frame);
      const verification = await verifyPortable(replayFrames(buffered), signingKey);
      expect(verification).toMatchObject({ valid: true, manifest: { recordCount: 1 } });
      expect(await repository.delete(tenantId, id, 1)).toBe(true);
      await importPortable(
        replayFrames(buffered),
        createPortableSink(target),
        exportId,
        signingKey,
      );
      const restored = await target.repository(repositoryName('users')).findById(tenantId, id);
      expect(restored).toMatchObject({ id, tenantId, version: 1, name: 'Ana' });
      expect(restored?.createdAt.toISOString()).toBe(createdAt.toISOString());
    } finally {
      await target
        .repository(repositoryName('users'))
        .delete(tenantId, id, 1)
        .catch(() => undefined);
      await source.close();
      await target.close();
    }
  });
});
