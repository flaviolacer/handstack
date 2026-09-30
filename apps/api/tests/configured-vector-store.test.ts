import { defineConfig } from '@handstack/config';
import { describe, expect, it, vi } from 'vitest';
import { ConfiguredVectorStore } from '../src/knowledge/configured-vector-store.js';

describe('configured vector store credentials', () => {
  it('resolves the typed credential reference through the tenant-scoped broker', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const resolve = vi.fn().mockResolvedValue('pinecone-secret');
    const store = new ConfiguredVectorStore(
      defineConfig({
        vectorStore: {
          adapter: 'pinecone',
          endpoint: 'https://vectors.example.test',
          collection: 'handstack',
          credentialReference: 'secret://vector-api-key',
        },
      }),
      { resolve } as never,
      {} as never,
    );

    try {
      await store.upsert({
        organizationId: 'org-a',
        id: 'vector-a',
        vector: [0.1, 0.2],
        metadata: { subjectId: 'subject-a' },
      });
      expect(resolve).toHaveBeenCalledWith('secret://vector-api-key', 'org-a', 'knowledge-vector');
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://vectors.example.test/vectors/upsert');
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        headers: { 'api-key': 'pinecone-secret' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
