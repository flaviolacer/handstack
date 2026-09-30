import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgVectorStore } from '../src/index.js';

const connectionString = (process.env.HANDSTACK_TEST_PGVECTOR_URL ?? '').trim();
const table = `hs_vectors_${randomUUID().replaceAll('-', '')}`;
const pool = connectionString === '' ? undefined : new Pool({ connectionString });
const store = pool === undefined ? undefined : new PgVectorStore({ pool, table });

describe.skipIf(connectionString === '')('pgvector adapter integration', () => {
  beforeAll(async () => {
    await store?.ensureSchema();
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await pool.end();
    }
  });

  it('isolates tenants through real PostgreSQL vector search and deletion', async () => {
    if (store === undefined) throw new Error('pgvector store is not configured');
    const sharedId = randomUUID();
    await store.upsert({
      organizationId: 'org-a',
      id: sharedId,
      vector: [1, 0],
      metadata: { documentId: 'doc-a', subjectId: 'subject-a' },
    });
    await store.upsert({
      organizationId: 'org-b',
      id: sharedId,
      vector: [1, 0],
      metadata: { documentId: 'doc-b', subjectId: 'subject-b' },
    });

    expect(
      (
        await store.search({
          organizationId: 'org-a',
          vector: [1, 0],
          topK: 10,
          filter: { documentId: 'doc-a' },
        })
      ).map(({ id, metadata }) => ({ id, metadata })),
    ).toEqual([{ id: sharedId, metadata: { documentId: 'doc-a', subjectId: 'subject-a' } }]);

    await store.delete('org-a', [sharedId]);
    expect(await store.search({ organizationId: 'org-a', vector: [1, 0], topK: 10 })).toEqual([]);
    expect(
      (await store.search({ organizationId: 'org-b', vector: [1, 0], topK: 10 })).map(
        ({ id }) => id,
      ),
    ).toEqual([sharedId]);

    await store.upsert({
      organizationId: 'org-b',
      id: randomUUID(),
      vector: [0, 1],
      metadata: { documentId: 'doc-c', subjectId: 'subject-c' },
    });
    expect(await store.deleteBySubject('org-b', 'subject-c')).toBe(1);
    expect(
      (await store.search({ organizationId: 'org-b', vector: [1, 0], topK: 10 })).map(
        ({ id }) => id,
      ),
    ).toEqual([sharedId]);
  });
});
