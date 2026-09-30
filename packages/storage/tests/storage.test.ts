import { describe, expect, it } from 'vitest';
import {
  AzureBlobStorageProvider,
  CloudflareR2StorageProvider,
  createStorageProvider,
  GcsStorageProvider,
  InMemoryStorageProvider,
  LocalStorageProvider,
  S3StorageProvider,
  validateUpload,
} from '../src/index.js';

describe('StorageProvider', () => {
  it('isolates objects by organization and returns signed URLs', async () => {
    const storage = new InMemoryStorageProvider();
    const object = await storage.put({
      organizationId: 'org',
      body: new Uint8Array([1, 2]),
      contentType: 'text/plain',
    });
    await expect(storage.get('other', object.key)).resolves.toBeUndefined();
    await expect(storage.get('org', object.key)).resolves.toMatchObject({ object: { size: 2 } });
    await expect(storage.signedUrl('org', object.key, 60)).resolves.toMatch(/^memory:/u);
  });

  it('enforces upload and malware policy hooks', async () => {
    const body = new Uint8Array([1]);
    expect(() => {
      validateUpload(
        { filename: 'a.exe', contentType: 'application/octet-stream', body },
        { maxBytes: 10, allowedMimeTypes: ['text/plain'], allowedExtensions: ['.txt'] },
      );
    }).toThrow(/MIME/);
    const scan = () => Promise.reject(new Error('malware'));
    await expect(
      new InMemoryStorageProvider({
        maxBytes: 10,
        allowedMimeTypes: ['text/plain'],
        allowedExtensions: ['.txt'],
        malwareScan: scan,
      }).put({ organizationId: 'org', body, contentType: 'text/plain' }),
    ).rejects.toThrow(/malware/);
  });

  it('exposes portable Local/S3/R2/Azure/GCS adapters over an injected backend', async () => {
    const backend = new InMemoryStorageProvider();
    const providers = [
      new LocalStorageProvider({ backend }),
      new S3StorageProvider({ backend }),
      new CloudflareR2StorageProvider({ backend }),
      new AzureBlobStorageProvider({ backend }),
      new GcsStorageProvider({ backend }),
    ];
    for (const provider of providers) {
      const object = await provider.put({
        organizationId: 'org',
        key: provider.constructor.name,
        body: new Uint8Array([1]),
        contentType: 'text/plain',
      });
      await expect(provider.get('org', object.key)).resolves.toBeDefined();
      await expect(provider.signedUrl('org', object.key, 30)).resolves.toMatch(
        /^(file|s3|r2|azure-blob|gs):/u,
      );
    }
  });

  it('selects every official adapter through the typed factory', async () => {
    const backend = new InMemoryStorageProvider();
    const kinds = ['local', 's3', 'r2', 'azure-blob', 'gcs'] as const;
    for (const adapter of kinds) {
      const provider = createStorageProvider({ adapter, options: { backend } });
      const object = await provider.put({
        organizationId: 'factory-org',
        key: `${adapter}/object`,
        body: new Uint8Array([7]),
        contentType: 'application/octet-stream',
      });
      await expect(provider.get('factory-org', object.key)).resolves.toMatchObject({
        object: { organizationId: 'factory-org' },
      });
      await expect(provider.signedUrl('factory-org', object.key, 30)).resolves.toMatch(
        /^(file|s3|r2|azure-blob|gs):/u,
      );
    }
  });

  it('uses an injected S3 client with tenant-prefixed keys and signed URLs', async () => {
    const sent: unknown[] = [];
    const client = {
      send: (command: unknown) => {
        sent.push(command);
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'HeadObjectCommand')
          return Promise.resolve({
            ContentType: 'text/plain',
            ContentLength: 3,
            ETag: '"etag"',
            LastModified: new Date('2026-01-01T00:00:00Z'),
          });
        if (name === 'GetObjectCommand')
          return Promise.resolve({
            Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3])) },
          });
        return Promise.resolve({});
      },
    };
    const storage = new S3StorageProvider({
      client: client as never,
      bucket: 'handstack-test',
      keyPrefix: 'hs',
      signer: (_client, command) =>
        Promise.resolve(`https://s3.test/${(command.input as { Key: string }).Key}`),
    });
    await expect(
      storage.put({
        organizationId: 'org-a',
        key: 'doc.txt',
        body: new Uint8Array([1, 2, 3]),
        contentType: 'text/plain',
      }),
    ).resolves.toMatchObject({ key: 'doc.txt', organizationId: 'org-a' });
    await expect(storage.get('org-a', 'doc.txt')).resolves.toMatchObject({
      object: { key: 'doc.txt' },
      body: new Uint8Array([1, 2, 3]),
    });
    await expect(storage.signedUrl('org-a', 'doc.txt', 60)).resolves.toMatch(/^https?:/u);
    expect(sent.length).toBeGreaterThanOrEqual(4);
  });
});
