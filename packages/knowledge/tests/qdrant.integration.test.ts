import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QdrantVectorStore } from '../src/index.js';

const endpoint = (process.env.HANDSTACK_TEST_QDRANT_URL ?? '').trim().replace(/\/+$/u, '');
const collection = `handstack_conformance_${randomUUID().replaceAll('-', '')}`;
const request = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  return fetch(`${endpoint}${path}`, { ...init, headers });
};

describe.skipIf(endpoint === '')('Qdrant vector adapter integration', () => {
  beforeAll(async () => {
    const response = await request(`/collections/${collection}`, {
      method: 'PUT',
      body: JSON.stringify({ vectors: { size: 2, distance: 'Cosine' } }),
    });
    expect(response.ok).toBe(true);
  });

  afterAll(async () => {
    await request(`/collections/${collection}`, { method: 'DELETE' });
  });

  it('upserts, searches and deletes points without crossing organization boundaries', async () => {
    const store = new QdrantVectorStore({ endpoint, collection });
    const organizationPoint = randomUUID();
    const otherOrganizationPoint = randomUUID();
    await store.upsert({
      organizationId: 'org-a',
      id: organizationPoint,
      vector: [1, 0],
      metadata: { documentId: 'doc-a', subjectId: 'subject-a' },
    });
    await store.upsert({
      organizationId: 'org-b',
      id: otherOrganizationPoint,
      vector: [1, 0],
      metadata: { documentId: 'doc-b', subjectId: 'subject-b' },
    });

    const organizationResults = await store.search({
      organizationId: 'org-a',
      vector: [1, 0],
      topK: 10,
    });
    expect(organizationResults.map(({ id }) => id)).toEqual([organizationPoint]);

    await store.delete('org-a', [organizationPoint, otherOrganizationPoint]);
    expect(await store.search({ organizationId: 'org-a', vector: [1, 0], topK: 10 })).toEqual([]);
    expect(
      (await store.search({ organizationId: 'org-b', vector: [1, 0], topK: 10 })).map(
        ({ id }) => id,
      ),
    ).toEqual([otherOrganizationPoint]);

    await store.deleteBySubject('org-b', 'subject-b');
    expect(await store.search({ organizationId: 'org-b', vector: [1, 0], topK: 10 })).toEqual([]);
  });
});
