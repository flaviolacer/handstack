import type { Repository, TenantEntity } from '@handstack/domain';
import { repositoryName, uuidV7 } from '@handstack/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PersistenceConcurrencyError,
  PersistenceConflictError,
  TypeOrmAdapter,
} from '../src/index.js';

interface TestEntity extends TenantEntity {
  readonly label: string;
}

function entity(tenantId: string, label: string, createdAt = new Date()): TestEntity {
  return {
    id: uuidV7(createdAt.getTime()),
    tenantId,
    version: 1,
    createdAt,
    updatedAt: createdAt,
    label,
  };
}

describe('TypeORM repository conformance (SQLite)', () => {
  let adapter: TypeOrmAdapter;
  let repository: Repository<TestEntity>;

  beforeEach(async () => {
    adapter = await new TypeOrmAdapter({ adapter: 'sqlite' }).initialize();
    repository = adapter.repository(repositoryName('conformance-entity'));
  });

  afterEach(async () => adapter.close());

  it('isolates tenants and maps duplicate keys to a canonical conflict', async () => {
    const first = entity('tenant-a', 'first');
    await repository.insert(first);
    expect(await repository.findById('tenant-a', first.id)).toMatchObject({ label: 'first' });
    expect(await repository.findById('tenant-b', first.id)).toBeUndefined();
    await expect(repository.insert(first)).rejects.toBeInstanceOf(PersistenceConflictError);
  });

  it('uses deterministic cursor pagination', async () => {
    const base = 1_700_000_000_000;
    for (let index = 0; index < 5; index += 1) {
      await repository.insert(entity('tenant-a', `item-${String(index)}`, new Date(base + index)));
    }
    const first = await repository.list('tenant-a', { limit: 2 });
    expect(first.nextCursor).toBeDefined();
    const second = await repository.list('tenant-a', {
      limit: 2,
      cursor: first.nextCursor ?? '',
    });
    expect(first.items.map((item) => item.label)).toEqual(['item-0', 'item-1']);
    expect(second.items.map((item) => item.label)).toEqual(['item-2', 'item-3']);
  });

  it('enforces optimistic concurrency for update and delete', async () => {
    const original = entity('tenant-a', 'original');
    await repository.insert(original);
    const changed = {
      ...original,
      version: 2,
      label: 'changed',
      updatedAt: new Date(original.updatedAt.getTime() + 1),
    };
    await repository.update(changed, 1);
    await expect(repository.update({ ...changed, version: 3 }, 1)).rejects.toBeInstanceOf(
      PersistenceConcurrencyError,
    );
    await expect(repository.delete('tenant-a', original.id, 1)).rejects.toBeInstanceOf(
      PersistenceConcurrencyError,
    );
    expect(await repository.delete('tenant-a', original.id, 2)).toBe(true);
  });

  it('rolls back an entire transaction on failure', async () => {
    const value = entity('tenant-a', 'rolled-back');
    await expect(
      adapter.run(async (transaction) => {
        await transaction
          .repository<TestEntity>(repositoryName('conformance-entity'))
          .insert(value);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    expect(await repository.findById('tenant-a', value.id)).toBeUndefined();
  });
});
