import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChromaVectorStore } from '../src/index.js';

const endpoint = (process.env.HANDSTACK_TEST_CHROMA_URL ?? '').trim().replace(/\/+$/u, '');
const collection = `handstack_conformance_${randomUUID().replaceAll('-', '')}`;
const collectionRoot = '/api/v2/tenants/default_tenant/databases/default_database/collections';
const request = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  return fetch(`${endpoint}${path}`, { ...init, headers });
};

describe.skipIf(endpoint === '')('Chroma vector adapter integration', () => {
  let collectionId = '';

  beforeAll(async () => {
    const response = await request(collectionRoot, {
      method: 'POST',
      body: JSON.stringify({ name: collection }),
    });
    expect(response.ok).toBe(true);
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('id' in body) || typeof body.id !== 'string')
      throw new Error('Chroma collection response did not include an id');
    collectionId = body.id;
  });

  afterAll(async () => {
    if (collectionId !== '')
      await request(`${collectionRoot}/${encodeURIComponent(collectionId)}`, { method: 'DELETE' });
  });

  it('uses v2 collection IDs and enforces tenant metadata filters on real search and deletion', async () => {
    const store = new ChromaVectorStore({ endpoint, collection });
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

    expect(
      (
        await store.search({
          organizationId: 'org-a',
          vector: [1, 0],
          topK: 10,
          filter: { documentId: 'doc-a', organizationId: 'org-b' },
        })
      ).map(({ id }) => id),
    ).toEqual([organizationPoint]);

    await store.delete('org-a', [organizationPoint, otherOrganizationPoint]);
    expect(await store.search({ organizationId: 'org-a', vector: [1, 0], topK: 10 })).toEqual([]);
    expect(
      (await store.search({ organizationId: 'org-b', vector: [1, 0], topK: 10 })).map(
        ({ id }) => id,
      ),
    ).toEqual([otherOrganizationPoint]);

    expect(await store.deleteBySubject('org-b', 'subject-b')).toBe(1);
    expect(await store.search({ organizationId: 'org-b', vector: [1, 0], topK: 10 })).toEqual([]);
  });
});
