import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3KnowledgeSourceConnector } from '../src/index.js';

const endpoint = process.env.HANDSTACK_TEST_OBJECT_STORAGE_URL?.trim() ?? '';
const accessKeyId = process.env.HANDSTACK_TEST_OBJECT_STORAGE_ACCESS_KEY ?? 'minioadmin';
const secretAccessKey = process.env.HANDSTACK_TEST_OBJECT_STORAGE_SECRET_KEY ?? 'minioadmin';

describe.skipIf(endpoint === '')('S3 Knowledge source against a real S3-compatible service', () => {
  const bucket = 'handstack-knowledge-source';
  const key = 'integration/private-handbook.txt';
  const storage = new S3Client({
    ...(endpoint === '' ? {} : { endpoint }),
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  beforeAll(async () => {
    await storage.send(new CreateBucketCommand({ Bucket: bucket }));
    await storage.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: 'Tenant-private S3 source integration evidence',
        ContentType: 'text/plain',
      }),
    );
  });

  afterAll(async () => {
    try {
      await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      await storage.send(new DeleteBucketCommand({ Bucket: bucket }));
    } finally {
      storage.destroy();
    }
  });

  it('resolves a tenant credential reference and fetches source bytes and provider version', async () => {
    const connector = new S3KnowledgeSourceConnector(
      (organizationId, reference) => {
        expect(organizationId).toBe('knowledge-s3-org');
        expect(reference).toBe('secret://knowledge-s3-integration');
        return Promise.resolve(
          JSON.stringify({
            region: 'us-east-1',
            accessKeyId,
            secretAccessKey,
            ...(endpoint === '' ? {} : { endpoint }),
          }),
        );
      },
      (credential) =>
        new S3Client({
          ...(credential.endpoint === undefined ? {} : { endpoint: credential.endpoint }),
          region: credential.region,
          forcePathStyle: true,
          credentials: {
            accessKeyId: credential.accessKeyId,
            secretAccessKey: credential.secretAccessKey,
            ...(credential.sessionToken === undefined
              ? {}
              : { sessionToken: credential.sessionToken }),
          },
        }),
    );

    const result = await connector.fetch({
      organizationId: 'knowledge-s3-org',
      locator: `s3://${bucket}/${key}`,
      credentialReference: 'secret://knowledge-s3-integration',
    });

    expect(result.content).toBe('Tenant-private S3 source integration evidence');
    expect(result.sourceVersion).toMatch(/^".+"$/u);
  });
});
