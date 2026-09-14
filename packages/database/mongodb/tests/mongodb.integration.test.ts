import { MongoAdapter } from '../src/index.js';
import { verifyRepositoryConformance } from '@handstack/domain';
import { describe, expect, it } from 'vitest';

describe('MongoDB repository conformance', () => {
  it('passes the canonical adapter harness on a replica set', async () => {
    const url = process.env.HANDSTACK_TEST_MONGODB_URL;
    if (url === undefined) throw new Error('HANDSTACK_TEST_MONGODB_URL is required');
    const adapter = await new MongoAdapter(url, 'handstack_test').initialize();
    try {
      const report = await verifyRepositoryConformance(adapter, 'mongodb');
      expect(report.checks).toHaveLength(6);
    } finally {
      await adapter.close();
    }
  });
});
