import { verifyRepositoryConformance } from '@handstack/domain';
import { describe, expect, it } from 'vitest';
import { TypeOrmAdapter, type SqlAdapterConfig } from '../src/index.js';

describe('official SQL repository conformance', () => {
  it('passes the canonical harness for the requested adapter', async () => {
    const adapterName = process.env.HANDSTACK_TEST_SQL_ADAPTER;
    const url = process.env.HANDSTACK_TEST_SQL_URL;
    if (!['mysql', 'mariadb', 'sqlserver'].includes(adapterName ?? '')) {
      throw new Error('HANDSTACK_TEST_SQL_ADAPTER must be mysql, mariadb, or sqlserver');
    }
    if (url === undefined) throw new Error('HANDSTACK_TEST_SQL_URL is required');
    const config = { adapter: adapterName, url } as SqlAdapterConfig;
    const adapter = await new TypeOrmAdapter(config).initialize();
    try {
      const report = await verifyRepositoryConformance(adapter, adapterName ?? 'sql');
      expect(report.checks).toHaveLength(6);
    } finally {
      await adapter.close();
    }
  });
});
