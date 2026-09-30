import { CreateBucketCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CloudflareR2StorageProvider,
  GcsStorageProvider,
  S3StorageProvider,
  type StorageProvider,
} from '../src/index.js';

describe('S3-compatible object storage integration', () => {
  const endpoint = process.env.HANDSTACK_TEST_OBJECT_STORAGE_URL;
  if (endpoint === undefined || endpoint.trim() === '')
    throw new Error('HANDSTACK_TEST_OBJECT_STORAGE_URL is required');
  const bucket = 'handstack-conformance';
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.HANDSTACK_TEST_OBJECT_STORAGE_ACCESS_KEY ?? 'minioadmin',
      secretAccessKey: process.env.HANDSTACK_TEST_OBJECT_STORAGE_SECRET_KEY ?? 'minioadmin',
    },
  });

  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    await Promise.all([
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: 'handstack/s3-org/doc.txt' })),
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: 'handstack/r2-org/doc.txt' })),
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: 'handstack/gcs-org/doc.txt' })),
    ]);
    client.destroy();
  });

  it('runs S3, R2 and GCS adapters against a real S3-compatible service', async () => {
    const providers: readonly [string, StorageProvider][] = [
      ['s3', new S3StorageProvider({ client, bucket })],
      ['r2', new CloudflareR2StorageProvider({ client, bucket })],
      ['gcs', new GcsStorageProvider({ client, bucket })],
    ];
    for (const [kind, provider] of providers) {
      const organizationId = `${kind}-org`;
      const object = await provider.put({
        organizationId,
        key: 'doc.txt',
        body: new Uint8Array([1, 2, 3]),
        contentType: 'text/plain',
      });
      await expect(provider.get(organizationId, object.key)).resolves.toMatchObject({
        object: { organizationId, size: 3 },
        body: new Uint8Array([1, 2, 3]),
      });
      await expect(provider.get('other-org', object.key)).resolves.toBeUndefined();
      await expect(provider.signedUrl(organizationId, object.key, 60)).resolves.toMatch(
        /^https?:/u,
      );
      await provider.delete(organizationId, object.key);
      await expect(provider.get(organizationId, object.key)).resolves.toBeUndefined();
    }
  });
});
