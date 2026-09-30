import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoAtlasVectorStore } from '../src/index.js';

const connectionString = (process.env.HANDSTACK_TEST_MONGODB_ATLAS_VECTOR_URL ?? '').trim();
const databaseName = `handstack_vector_${randomUUID().replaceAll('-', '')}`;
const collectionName = 'knowledge_vectors';
const indexName = 'handstack-vector-index';
const client =
  connectionString === ''
    ? undefined
    : new MongoClient(connectionString, { serverSelectionTimeoutMS: 2_000 });
const collection =
  client === undefined ? undefined : client.db(databaseName).collection(collectionName);
const store = collection === undefined ? undefined : new MongoAtlasVectorStore({ collection });

describe.skipIf(connectionString === '')('MongoDB Atlas Vector Search integration', () => {
  beforeAll(async () => {
    if (client === undefined || collection === undefined)
      throw new Error('MongoDB Atlas Vector Search is not configured');
    let connected = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await client.connect();
        connected = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    expect(connected).toBe(true);
    await client.db(databaseName).createCollection(collectionName);
    await collection.createSearchIndex({
      name: indexName,
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'vector', numDimensions: 2, similarity: 'cosine' },
          { type: 'filter', path: 'organizationId' },
          { type: 'filter', path: 'metadata.documentId' },
          { type: 'filter', path: 'metadata.subjectId' },
        ],
      },
    });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const indexes = await collection.listSearchIndexes(indexName).toArray();
      if (
        indexes.some(
          (index) =>
            'status' in index &&
            index.status === 'READY' &&
            'queryable' in index &&
            index.queryable === true,
        )
      ) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(ready).toBe(true);
  }, 90_000);

  afterAll(async () => {
    if (client !== undefined) {
      await client.db(databaseName).dropDatabase();
      await client.close();
    }
  });

  it('pre-filters nested metadata and deletes only the selected tenant', async () => {
    if (store === undefined) throw new Error('MongoDB Atlas vector store is not configured');
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

    let organizationMatches = await store.search({
      organizationId: 'org-a',
      vector: [1, 0],
      topK: 10,
      filter: { documentId: 'doc-a', organizationId: 'org-b' },
    });
    for (let attempt = 0; attempt < 60 && organizationMatches.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      organizationMatches = await store.search({
        organizationId: 'org-a',
        vector: [1, 0],
        topK: 10,
        filter: { documentId: 'doc-a', organizationId: 'org-b' },
      });
    }
    expect(organizationMatches.map(({ id, metadata }) => ({ id, metadata }))).toEqual([
      { id: sharedId, metadata: { documentId: 'doc-a', subjectId: 'subject-a' } },
    ]);

    await store.delete('org-a', [sharedId]);
    expect(await store.search({ organizationId: 'org-a', vector: [1, 0], topK: 10 })).toEqual([]);
    expect(
      (await store.search({ organizationId: 'org-b', vector: [1, 0], topK: 10 })).map(
        ({ id }) => id,
      ),
    ).toEqual([sharedId]);
    expect(await store.deleteBySubject('org-b', 'subject-b')).toBe(1);
    expect(await store.search({ organizationId: 'org-b', vector: [1, 0], topK: 10 })).toEqual([]);
  });
});
