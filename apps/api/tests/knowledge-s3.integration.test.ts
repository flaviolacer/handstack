import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import type { DatabaseService } from '../src/database/database.service.js';
import type { ModelAdminRuntimeService } from '../src/models/model-admin-runtime.service.js';
import { KnowledgeRuntimeService } from '../src/knowledge/knowledge-runtime.service.js';
import { KnowledgeSyncSchedulerService } from '../src/knowledge/knowledge-sync-scheduler.service.js';
import { AuditRuntimeService } from '../src/audit/audit-runtime.service.js';
import { SecretRuntimeService } from '../src/secrets/secret-runtime.service.js';
import { repositoryName, type TenantEntity } from '@handstack/domain';
import { afterAll, describe, expect, it } from 'vitest';

const endpoint = process.env.HANDSTACK_TEST_OBJECT_STORAGE_URL?.trim() ?? '';
const accessKeyId = process.env.HANDSTACK_TEST_OBJECT_STORAGE_ACCESS_KEY ?? 'minioadmin';
const secretAccessKey = process.env.HANDSTACK_TEST_OBJECT_STORAGE_SECRET_KEY ?? 'minioadmin';
const masterKeyEnvironment = process.env.HANDSTACK_MASTER_KEY;

interface SchedulerLease extends TenantEntity {
  readonly organizationId: string;
  readonly ownerId: string;
  readonly leaseUntil: number;
}

describe.skipIf(endpoint === '')('Knowledge API S3 source end-to-end integration', () => {
  const organizationId = 'knowledge-s3-api-integration';
  const bucket = 'handstack-knowledge-api';
  const key = 'sources/handbook.txt';
  const content = 'Tenant-scoped Knowledge synchronized from S3 through the secret vault.';
  const storage = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  afterAll(() => {
    storage.destroy();
  });

  it('resolves an encrypted vault reference and indexes content fetched from S3', async () => {
    const previousOrganizations = process.env.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS;
    const previousInstanceId = process.env.HANDSTACK_KNOWLEDGE_SYNC_INSTANCE_ID;
    process.env.HANDSTACK_MASTER_KEY =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const config = defineConfig({
      database: { adapter: 'sqlite', url: 'file::memory:' },
      vectorStore: { adapter: 'repository' },
    });
    const adapter = createDatabaseAdapter(config);
    let bucketCreated = false;

    try {
      await adapter.initialize();
      await storage.send(new CreateBucketCommand({ Bucket: bucket }));
      bucketCreated = true;
      await storage.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: content,
          ContentType: 'text/plain',
        }),
      );

      const database = { adapter, config } as unknown as DatabaseService;
      const audit = new AuditRuntimeService(database);
      const vault = new SecretRuntimeService(database, audit);
      const secret = await vault.create({
        organizationId,
        actorId: 'knowledge-admin',
        name: 'S3 source credential',
        pluginId: 'knowledge-s3',
        value: JSON.stringify({ region: 'us-east-1', accessKeyId, secretAccessKey, endpoint }),
      });
      const models = {
        execution: {
          embed: ({ input }: { readonly input: readonly string[] }) =>
            Promise.resolve({ vectors: input.map(() => [1, 0]) }),
        },
      } as unknown as ModelAdminRuntimeService;
      const knowledge = new KnowledgeRuntimeService(database, models, vault);
      const base = await knowledge.createBase(organizationId, {
        name: 'S3 private handbook',
        description: 'End-to-end S3 source ingestion through the tenant vault',
        chunkSize: 1,
        chunkOverlap: 0,
        strategy: 'PARAGRAPH',
        metadataExtraction: false,
        embeddingModel: 'integration-embedding',
      });
      const now = new Date();
      const document = await knowledge.createDocument(organizationId, {
        knowledgeBaseId: base.id,
        sourceType: 'S3',
        sourceLocator: `s3://${bucket}/${key}`,
        credentialReference: `secret://${secret.id}`,
        title: 'Private handbook',
        contentDigest: 'initial-placeholder-digest',
        sourceId: 's3-private-handbook',
        sourceVersion: 'initial',
        sourceAcl: [{ principalId: 'knowledge-reader', permissions: ['read'] }],
        classification: 'CONFIDENTIAL',
        residency: 'us-east',
        ingestedAt: now,
        lastVerifiedAt: now,
        retentionPolicy: { retentionDays: 30, legalHold: false },
        deletionStatus: 'ACTIVE',
      });

      process.env.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS = organizationId;
      process.env.HANDSTACK_KNOWLEDGE_SYNC_INSTANCE_ID = 'knowledge-s3-scheduler-integration';
      const scheduler = new KnowledgeSyncSchedulerService(knowledge, database);
      await expect(scheduler.tick()).resolves.toBe(1);
      const synchronized = await knowledge
        .listDocuments(organizationId)
        .then((documents) => documents.find((item) => item.id === document.id));

      expect(synchronized).toBeDefined();
      expect(synchronized?.contentDigest).not.toBe('initial-placeholder-digest');
      await expect(knowledge.listVersions(organizationId, document.id)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ documentId: document.id, documentVersion: 2 }),
        ]),
      );
      await expect(audit.query(organizationId, 'SECRET_ACCESSED')).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resourceId: secret.id, actorType: 'SYSTEM' }),
        ]),
      );
      const lease = await adapter
        .repository<SchedulerLease>(repositoryName('knowledge-sync-scheduler-leases'))
        .findById(organizationId, `${organizationId}:knowledge-sync`);
      expect(lease).toMatchObject({ ownerId: 'knowledge-s3-scheduler-integration', leaseUntil: 0 });
    } finally {
      if (previousOrganizations === undefined)
        delete process.env.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS;
      else process.env.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS = previousOrganizations;
      if (previousInstanceId === undefined) delete process.env.HANDSTACK_KNOWLEDGE_SYNC_INSTANCE_ID;
      else process.env.HANDSTACK_KNOWLEDGE_SYNC_INSTANCE_ID = previousInstanceId;
      try {
        if (bucketCreated) {
          await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          await storage.send(new DeleteBucketCommand({ Bucket: bucket }));
        }
      } finally {
        try {
          await adapter.close();
        } finally {
          if (masterKeyEnvironment === undefined) delete process.env.HANDSTACK_MASTER_KEY;
          else process.env.HANDSTACK_MASTER_KEY = masterKeyEnvironment;
        }
      }
    }
  });
});

afterAll(() => {
  if (masterKeyEnvironment === undefined) delete process.env.HANDSTACK_MASTER_KEY;
  else process.env.HANDSTACK_MASTER_KEY = masterKeyEnvironment;
});
