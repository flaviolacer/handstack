import { describe, expect, it } from 'vitest';
import {
  AzureBlobStorageProvider,
  CloudflareR2StorageProvider,
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
});
