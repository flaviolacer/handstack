import { TypeOrmAdapter } from '../src/index.js';
import { verifyRepositoryConformance } from '@handstack/domain';
import { describe, expect, it } from 'vitest';

describe('PostgreSQL repository conformance', () => {
  it('passes the canonical adapter harness', async () => {
    const url = process.env.HANDSTACK_TEST_POSTGRESQL_URL;
    if (url === undefined) throw new Error('HANDSTACK_TEST_POSTGRESQL_URL is required');
    const adapter = await new TypeOrmAdapter({ adapter: 'postgresql', url }).initialize();
    try {
      const report = await verifyRepositoryConformance(adapter, 'postgresql');
      expect(report.checks).toHaveLength(6);
    } finally {
      await adapter.close();
    }
  });
});
