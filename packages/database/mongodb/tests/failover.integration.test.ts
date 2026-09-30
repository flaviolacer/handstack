import { afterAll, describe, expect, it } from 'vitest';
import { repositoryName, uuidV7, type TenantEntity } from '@handstack/domain';
import { MongoAdapter } from '../src/adapter.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const url = process.env.HANDSTACK_TEST_MONGODB_URL?.trim();
const primaryContainer = process.env.HANDSTACK_TEST_MONGODB_PRIMARY_CONTAINER?.trim();
const configuredUrl = url ?? '';
const run = promisify(execFile);

describe.skipIf(
  url === undefined || url === '' || primaryContainer === undefined || primaryContainer === '',
)('MongoDB replica-set failover', () => {
  let adapter: MongoAdapter | undefined;

  afterAll(async () => {
    if (adapter !== undefined) {
      await adapter.nativeDatabase().dropDatabase();
      await adapter.close();
    }
  });

  it('writes before and after primary loss', async () => {
    if (primaryContainer === undefined || primaryContainer === '')
      throw new Error('HANDSTACK_TEST_MONGODB_PRIMARY_CONTAINER is required');
    adapter = await new MongoAdapter(configuredUrl, 'handstack_failover_test').initialize();
    const repository = adapter.repository<TenantEntity>(repositoryName('failover-probe'));
    const beforeId = uuidV7();
    const afterId = uuidV7();
    await repository.insert({
      id: beforeId,
      tenantId: 'failover-org',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await run('docker', ['stop', primaryContainer]);
    await repository.insert({
      id: afterId,
      tenantId: 'failover-org',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(await repository.findById('failover-org', afterId)).toMatchObject({ id: afterId });
  }, 30_000);
});
