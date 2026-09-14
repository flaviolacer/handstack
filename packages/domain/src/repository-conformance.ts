import {
  repositoryName,
  type Repository,
  type RepositoryName,
  type TenantEntity,
  type TransactionManager,
} from './persistence.js';
import { uuidV7 } from './uuid-v7.js';

export interface ConformanceAdapter extends TransactionManager {
  repository<T extends TenantEntity>(name: RepositoryName): Repository<T>;
}

interface ConformanceEntity extends TenantEntity {
  readonly label: string;
}

export interface ConformanceReport {
  readonly adapterName: string;
  readonly checks: readonly string[];
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Repository conformance failed: ${message}`);
}

function entity(tenantId: string, label: string, time: number): ConformanceEntity {
  const timestamp = new Date(time);
  return {
    id: uuidV7(time),
    tenantId,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    label,
  };
}

async function mustReject(operation: () => Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    ensure(
      error instanceof Error && 'code' in error && error.code === expectedCode,
      `expected ${expectedCode}, received ${error instanceof Error ? error.name : typeof error}`,
    );
    return;
  }
  throw new Error(`Repository conformance failed: expected rejection ${expectedCode}`);
}

export async function verifyRepositoryConformance(
  adapter: ConformanceAdapter,
  adapterName: string,
): Promise<ConformanceReport> {
  const name = repositoryName(
    `conformance-${adapterName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  );
  const repository = adapter.repository<ConformanceEntity>(name);
  const base = 1_700_100_000_000;
  const first = entity('tenant-a', 'item-0', base);

  await repository.insert(first);
  ensure(
    (await repository.findById('tenant-a', first.id))?.label === 'item-0',
    'insert/read parity',
  );
  ensure((await repository.findById('tenant-b', first.id)) === undefined, 'tenant isolation');
  await mustReject(() => repository.insert(first), 'persistence_conflict');

  for (let index = 1; index < 5; index += 1) {
    await repository.insert(entity('tenant-a', `item-${String(index)}`, base + index));
  }
  const firstPage = await repository.list('tenant-a', { limit: 2 });
  ensure(firstPage.nextCursor !== undefined, 'first page cursor');
  const secondPage = await repository.list('tenant-a', {
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  ensure(
    firstPage.items.map((item) => item.label).join(',') === 'item-0,item-1' &&
      secondPage.items.map((item) => item.label).join(',') === 'item-2,item-3',
    'deterministic cursor order',
  );

  const changed = { ...first, label: 'changed', version: 2, updatedAt: new Date(base + 10) };
  await repository.update(changed, 1);
  await mustReject(
    () => repository.update({ ...changed, version: 3 }, 1),
    'persistence_concurrency_conflict',
  );

  const rollbackValue = entity('tenant-a', 'rollback', base + 100);
  try {
    await adapter.run(async (transaction) => {
      await transaction.repository<ConformanceEntity>(name).insert(rollbackValue);
      throw new Error('conformance rollback');
    });
  } catch (error) {
    ensure(
      error instanceof Error && error.message === 'conformance rollback',
      'rollback error propagation',
    );
  }
  ensure(
    (await repository.findById('tenant-a', rollbackValue.id)) === undefined,
    'atomic rollback',
  );

  return {
    adapterName,
    checks: [
      'insert-read',
      'tenant-isolation',
      'duplicate-conflict',
      'cursor-order',
      'optimistic-concurrency',
      'transaction-rollback',
    ],
  };
}
