import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import type { ModelAdminRuntimeService } from '../src/models/model-admin-runtime.service.js';
import type { DatabaseService } from '../src/database/database.service.js';
import type { SecretRuntimeService } from '../src/secrets/secret-runtime.service.js';
import { KnowledgeRuntimeService } from '../src/knowledge/knowledge-runtime.service.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

describe('private knowledge source synchronization integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('ingests a remote source, revalidates ACL changes and propagates deletion', async () => {
    vi.stubEnv('HANDSTACK_KNOWLEDGE_ALLOWED_HOSTS', 'docs.example.test');
    const content = 'Private synchronization evidence\n\nSecond paragraph for retrieval';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(content, { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
    vi.stubGlobal('fetch', fetcher);

    const config = defineConfig({
      database: { adapter: 'sqlite', url: 'file::memory:' },
      vectorStore: { adapter: 'repository' },
    });
    const adapter = createDatabaseAdapter(config);
    await adapter.initialize();
    try {
      const models = {
        execution: {
          embed: vi.fn(({ input }: { readonly input: readonly string[] }) =>
            Promise.resolve({ vectors: input.map(() => [1, 0]) }),
          ),
        },
      } as unknown as ModelAdminRuntimeService;
      const secrets = { resolve: vi.fn() } as unknown as SecretRuntimeService;
      const knowledge = new KnowledgeRuntimeService(
        { adapter, config } as unknown as DatabaseService,
        models,
        secrets,
      );
      const base = await knowledge.createBase('sync-org', {
        name: 'Private source',
        description: 'Private source ACL synchronization',
        chunkSize: 1,
        chunkOverlap: 0,
        strategy: 'PARAGRAPH',
        metadataExtraction: false,
        embeddingModel: 'test-embedding',
      });
      const now = new Date();
      const document = await knowledge.createDocument('sync-org', {
        knowledgeBaseId: base.id,
        sourceType: 'URL',
        sourceLocator: 'https://docs.example.test/private-guide',
        title: 'Private guide',
        contentDigest: 'previous-digest',
        sourceId: 'docs-private-guide',
        sourceVersion: '1',
        sourceAcl: [{ principalId: 'reader-old', permissions: ['read'] }],
        classification: 'INTERNAL',
        residency: 'us-east',
        ingestedAt: now,
        lastVerifiedAt: now,
        retentionPolicy: { retentionDays: 30, legalHold: false },
        deletionStatus: 'ACTIVE',
      });

      const synchronized = await knowledge.syncUrl('sync-org', document.id);
      expect(synchronized.changed).toBe(true);
      expect(synchronized.chunks.length).toBeGreaterThan(0);
      expect(fetcher).toHaveBeenCalledOnce();
      await expect(
        knowledge.search(
          'sync-org',
          base.id,
          'Private synchronization',
          'test-embedding',
          'reader-old',
        ),
      ).resolves.toHaveLength(2);
      await expect(
        knowledge.search(
          'sync-org',
          base.id,
          'Private synchronization',
          'test-embedding',
          'reader-new',
        ),
      ).resolves.toHaveLength(0);

      await knowledge.syncDocument({
        organizationId: 'sync-org',
        documentId: document.id,
        operation: 'PERMISSION_CHANGED',
        sourceAcl: [{ principalId: 'reader-new', permissions: ['read'] }],
        lastVerifiedAt: new Date(),
        cursor: { connector: 'url', token: 'acl-version-2', issuedAt: new Date() },
      });
      await expect(
        knowledge.search(
          'sync-org',
          base.id,
          'Private synchronization',
          'test-embedding',
          'reader-old',
        ),
      ).resolves.toHaveLength(0);
      await expect(
        knowledge.search(
          'sync-org',
          base.id,
          'Private synchronization',
          'test-embedding',
          'reader-new',
        ),
      ).resolves.toHaveLength(2);

      await knowledge.syncDocument({
        organizationId: 'sync-org',
        documentId: document.id,
        operation: 'DELETE',
        cursor: { connector: 'url', token: 'delete-version-3', issuedAt: new Date() },
      });
      await expect(
        knowledge.search(
          'sync-org',
          base.id,
          'Private synchronization',
          'test-embedding',
          'reader-new',
        ),
      ).resolves.toHaveLength(0);
    } finally {
      await adapter.close();
    }
  });

  it('resolves private-source credentials through the tenant secret broker', async () => {
    vi.stubEnv('HANDSTACK_KNOWLEDGE_ALLOWED_HOSTS', 'www.googleapis.com');
    const content = 'Confidential drive content for authorized readers';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(content, { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    const config = defineConfig({
      database: { adapter: 'sqlite', url: 'file::memory:' },
      vectorStore: { adapter: 'repository' },
    });
    const adapter = createDatabaseAdapter(config);
    await adapter.initialize();
    try {
      const models = {
        execution: {
          embed: vi.fn(({ input }: { readonly input: readonly string[] }) =>
            Promise.resolve({ vectors: input.map(() => [1, 0]) }),
          ),
        },
      } as unknown as ModelAdminRuntimeService;
      const resolveSecret = vi.fn().mockResolvedValue('tenant-drive-token');
      const secrets = { resolve: resolveSecret } as unknown as SecretRuntimeService;
      const knowledge = new KnowledgeRuntimeService(
        { adapter, config } as unknown as DatabaseService,
        models,
        secrets,
      );
      const base = await knowledge.createBase('private-sync-org', {
        name: 'Private Drive',
        description: 'Vault-backed private source',
        chunkSize: 1,
        chunkOverlap: 0,
        strategy: 'PARAGRAPH',
        metadataExtraction: false,
        embeddingModel: 'test-embedding',
      });
      const now = new Date();
      const document = await knowledge.createDocument('private-sync-org', {
        knowledgeBaseId: base.id,
        sourceType: 'GOOGLE_DRIVE',
        sourceLocator: 'drive://file-42',
        credentialReference: 'secret://drive-token',
        title: 'Private Drive document',
        contentDigest: 'previous-digest',
        sourceId: 'drive-file-42',
        sourceVersion: '1',
        sourceAcl: [{ principalId: 'drive-reader', permissions: ['read'] }],
        classification: 'CONFIDENTIAL',
        residency: 'us-east',
        ingestedAt: now,
        lastVerifiedAt: now,
        retentionPolicy: { retentionDays: 30, legalHold: false },
        deletionStatus: 'ACTIVE',
      });

      const synchronized = await knowledge.syncUrl('private-sync-org', document.id);
      expect(synchronized.changed).toBe(true);
      expect(resolveSecret).toHaveBeenCalledWith(
        'secret://drive-token',
        'private-sync-org',
        'knowledge-google-drive',
      );
      expect(fetcher.mock.calls[0]?.[0]).toBe(
        'https://www.googleapis.com/drive/v3/files/file-42?alt=media',
      );
      const request = fetcher.mock.calls[0]?.[1];
      expect(request?.redirect).toBe('error');
      expect(new Headers(request?.headers).get('authorization')).toBe('Bearer tenant-drive-token');
      await expect(
        knowledge.search(
          'private-sync-org',
          base.id,
          'Confidential drive content',
          'test-embedding',
          'drive-reader',
        ),
      ).resolves.toHaveLength(1);
      await expect(
        knowledge.search(
          'private-sync-org',
          base.id,
          'Confidential drive content',
          'test-embedding',
          'other-reader',
        ),
      ).resolves.toHaveLength(0);
    } finally {
      await adapter.close();
    }
  });

  it('reindexes persisted tenant vectors and publishes the embedding model only on completion', async () => {
    const config = defineConfig({
      database: { adapter: 'sqlite', url: 'file::memory:' },
      vectorStore: { adapter: 'repository' },
    });
    const adapter = createDatabaseAdapter(config);
    await adapter.initialize();
    try {
      const embed = vi.fn(
        ({
          organizationId,
          model,
          input,
        }: {
          organizationId: string;
          model: string;
          input: readonly string[];
        }) => {
          expect(organizationId).toBe('reindex-org');
          return Promise.resolve({
            vectors: input.map(() => (model === 'new-embedding' ? [0, 1] : [1, 0])),
          });
        },
      );
      const models = { execution: { embed } } as unknown as ModelAdminRuntimeService;
      const secrets = { resolve: vi.fn() } as unknown as SecretRuntimeService;
      const knowledge = new KnowledgeRuntimeService(
        { adapter, config } as unknown as DatabaseService,
        models,
        secrets,
      );
      const organizationId = 'reindex-org';
      const base = await knowledge.createBase(organizationId, {
        name: 'Reindex base',
        description: 'Persisted model migration',
        chunkSize: 1,
        chunkOverlap: 0,
        strategy: 'PARAGRAPH',
        metadataExtraction: false,
        embeddingModel: 'old-embedding',
      });
      const now = new Date();
      const document = await knowledge.createDocument(organizationId, {
        knowledgeBaseId: base.id,
        sourceType: 'TEXT',
        sourceLocator: 'inline://reindex-source',
        title: 'Reindex source',
        contentDigest: 'reindex-digest',
        sourceId: 'reindex-source',
        sourceVersion: '1',
        sourceAcl: [{ principalId: '*', permissions: ['read'] }],
        classification: 'INTERNAL',
        residency: 'us-east',
        ingestedAt: now,
        lastVerifiedAt: now,
        retentionPolicy: { retentionDays: 30, legalHold: false },
        deletionStatus: 'ACTIVE',
      });
      await knowledge.ingest(organizationId, document.id, 'content to re-embed');

      const created = await knowledge.createReindexJob({
        organizationId,
        knowledgeBaseId: base.id,
        embeddingModel: 'new-embedding',
      });
      expect(created.status).toBe('PENDING');
      await expect(knowledge.getReindexJob('other-org', created.id)).resolves.toBeUndefined();
      await expect(knowledge.getReindexJob(organizationId, created.id)).resolves.toEqual(created);

      const completed = await knowledge.runReindexJob(organizationId, created.id);
      expect(completed).toMatchObject({
        status: 'SUCCEEDED',
        reindexed: 1,
        activeModelPublished: true,
      });
      expect((await knowledge.listBases(organizationId))[0]?.embeddingModel).toBe('new-embedding');
      await expect(
        knowledge.search(organizationId, base.id, 'content to re-embed', 'new-embedding', 'reader'),
      ).resolves.toHaveLength(1);
      expect(embed).toHaveBeenCalledTimes(3);
    } finally {
      await adapter.close();
    }
  });
});
