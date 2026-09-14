import { defineConfig } from '@handstack/config';
import {
  createPortableSource,
  createPortableSink,
  exportPortable,
  importPortable,
  MongoAdapter,
  TypeOrmAdapter,
  createDatabaseAdapter,
  verifyRepositoryConformance,
} from '../src/index.js';
import { repositoryName, uuidV7 } from '@handstack/domain';
import { describe, expect, it } from 'vitest';

describe('database adapter factory', () => {
  it('initializes compact SQLite and runs managed migrations', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    expect(adapter).toBeInstanceOf(TypeOrmAdapter);
    await adapter.initialize();
    const tables = await (adapter as TypeOrmAdapter).dataSource.query<unknown[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='handstack_entities'",
    );
    expect(tables).toHaveLength(1);
    await adapter.close();
  });

  it('passes the shared repository conformance harness on SQLite', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    const report = await verifyRepositoryConformance(adapter, 'sqlite');
    expect(report.checks).toHaveLength(6);
    await adapter.close();
  });

  it('streams tenant-scoped portable records from the SQL adapter', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    const createdAt = new Date('2026-08-31T12:00:00.000Z');
    const users = adapter.repository<{
      readonly id: string;
      readonly tenantId: string;
      readonly version: number;
      readonly createdAt: Date;
      readonly updatedAt: Date;
      readonly name: string;
    }>(repositoryName('users'));
    await users.insert({
      id: uuidV7(),
      tenantId: 'tenant-a',
      version: 1,
      createdAt,
      updatedAt: createdAt,
      name: 'Ana',
    });
    const exported = [];
    for await (const record of createPortableSource(adapter).records({ tenantId: 'tenant-a' })) {
      exported.push(record);
    }
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      repository: 'users',
      tenantId: 'tenant-a',
      version: 1,
      value: {
        name: 'Ana',
        createdAt: '2026-08-31T12:00:00.000Z',
        updatedAt: '2026-08-31T12:00:00.000Z',
      },
    });
    await adapter.close();
  });

  it('round-trips portable records through durable SQLite staging', async () => {
    const sourceAdapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    const targetAdapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await sourceAdapter.initialize();
    await targetAdapter.initialize();
    const timestamp = new Date('2026-08-31T12:00:00.000Z');
    const id = uuidV7();
    await sourceAdapter
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
    const frames = exportPortable(createPortableSource(sourceAdapter), {
      exportId: 'sqlite-roundtrip',
      signingKey: 'test-portable-signing-key',
    });
    await importPortable(
      frames,
      createPortableSink(targetAdapter),
      'sqlite-roundtrip',
      'test-portable-signing-key',
    );
    const restored = await targetAdapter
      .repository<{
        readonly id: string;
        readonly tenantId: string;
        readonly version: number;
        readonly createdAt: Date;
        readonly updatedAt: Date;
        readonly name: string;
      }>(repositoryName('users'))
      .findById('tenant-a', id);
    expect(restored).toMatchObject({ id, tenantId: 'tenant-a', version: 1, name: 'Ana' });
    expect(restored?.createdAt.toISOString()).toBe(timestamp.toISOString());
    await sourceAdapter.close();
    await targetAdapter.close();
  });

  it('selects MongoDB without creating a SQL adapter or opening a connection', () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'mongodb', url: 'mongodb://localhost/handstack' } }),
    );
    expect(adapter).toBeInstanceOf(MongoAdapter);
  });

  it.each([
    ['postgresql', 'postgresql://localhost/handstack'],
    ['mysql', 'mysql://localhost/handstack'],
    ['mariadb', 'mariadb://localhost/handstack'],
    ['sqlserver', 'mssql://localhost/handstack'],
  ] as const)(
    'selects the %s TypeORM adapter without opening a connection',
    (adapterName, url) => {
      const adapter = createDatabaseAdapter(
        defineConfig({ database: { adapter: adapterName, url } }),
      );
      expect(adapter).toBeInstanceOf(TypeOrmAdapter);
    },
    15_000,
  );
});
