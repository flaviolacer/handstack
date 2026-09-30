import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WeaviateVectorStore } from '../src/index.js';

const endpoint = (process.env.HANDSTACK_TEST_WEAVIATE_URL ?? '').trim().replace(/\/+$/u, '');
const collection = `HandStackConformance${randomUUID().replaceAll('-', '')}`;
const request = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  return fetch(`${endpoint}${path}`, { ...init, headers });
};

describe.skipIf(endpoint === '')('Weaviate vector adapter integration', () => {
  beforeAll(async () => {
    const response = await request('/v1/schema', {
      method: 'POST',
      body: JSON.stringify({
        class: collection,
        vectorizer: 'none',
        properties: ['organizationId', 'documentId', 'subjectId'].map((name) => ({
          name,
          dataType: ['text'],
        })),
        multiTenancyConfig: { enabled: true, autoTenantCreation: true },
      }),
    });
    expect(response.ok).toBe(true);
  });

  afterAll(async () => {
    await request(`/v1/schema/${collection}`, { method: 'DELETE' });
  });

  it('filters, upserts and deletes within the requested tenant', async () => {
    const store = new WeaviateVectorStore({ endpoint, collection });
    const sharedId = randomUUID();
    await store.upsert({
      organizationId: 'org-a',
      id: sharedId,
      vector: [1, 0],
      metadata: { documentId: 'doc-one', subjectId: 'subject-one' },
    });
    await store.upsert({
      organizationId: 'org-a',
      id: randomUUID(),
      vector: [0.9, 0.1],
      metadata: { documentId: 'doc-two', subjectId: 'subject-two' },
    });
    await store.upsert({
      organizationId: 'org-b',
      id: sharedId,
      vector: [1, 0],
      metadata: { documentId: 'doc-one', subjectId: 'subject-one' },
    });

    expect(
      (
        await store.search({
          organizationId: 'org-a',
          vector: [1, 0],
          topK: 10,
          filter: { documentId: 'doc-one', organizationId: 'org-b' },
        })
      ).map(({ id }) => id),
    ).toEqual([sharedId]);

    await store.delete('org-a', [sharedId]);
    expect(await store.search({ organizationId: 'org-a', vector: [1, 0], topK: 10 })).toHaveLength(
      1,
    );
    expect(
      (await store.search({ organizationId: 'org-b', vector: [1, 0], topK: 10 })).map(
        ({ id }) => id,
      ),
    ).toEqual([sharedId]);

    await store.deleteBySubject('org-b', 'subject-one');
    expect(await store.search({ organizationId: 'org-b', vector: [1, 0], topK: 10 })).toEqual([]);
  });
});
