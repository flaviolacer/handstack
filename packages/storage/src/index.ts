import { randomUUID } from 'node:crypto';
import { ValidationError } from '@handstack/shared';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  BlobSASPermissions,
  type BlockBlobClient,
  type BlobServiceClient,
} from '@azure/storage-blob';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface StoredObject {
  readonly key: string;
  readonly organizationId: string;
  readonly contentType: string;
  readonly size: number;
  readonly etag: string;
  readonly createdAt: Date;
}

export interface StorageProvider {
  put(input: {
    readonly organizationId: string;
    readonly key?: string;
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }): Promise<StoredObject>;
  get(
    organizationId: string,
    key: string,
  ): Promise<{ readonly object: StoredObject; readonly body: Uint8Array } | undefined>;
  delete(organizationId: string, key: string): Promise<void>;
  signedUrl(organizationId: string, key: string, expiresInSeconds: number): Promise<string>;
}

export type StorageAdapterKind = 'local' | 's3' | 'r2' | 'azure-blob' | 'gcs';

export interface StorageProviderFactoryOptions {
  readonly adapter: StorageAdapterKind;
  readonly options?:
    StorageAdapterOptions | S3StorageAdapterOptions | AzureBlobStorageAdapterOptions;
}

export interface FileSecurityPolicy {
  readonly maxBytes: number;
  readonly allowedMimeTypes: readonly string[];
  readonly allowedExtensions: readonly string[];
  readonly malwareScan?: (body: Uint8Array) => Promise<void>;
}

export function validateUpload(
  input: { readonly filename: string; readonly contentType: string; readonly body: Uint8Array },
  policy: FileSecurityPolicy,
): void {
  if (input.body.byteLength > policy.maxBytes) throw new ValidationError('File exceeds size limit');
  if (!policy.allowedMimeTypes.includes(input.contentType))
    throw new ValidationError('File MIME type is not allowed');
  const dot = input.filename.lastIndexOf('.');
  const extension = dot < 0 ? '' : input.filename.slice(dot).toLowerCase();
  if (!policy.allowedExtensions.includes(extension))
    throw new ValidationError('File extension is not allowed');
}

export class InMemoryStorageProvider implements StorageProvider {
  private readonly objects = new Map<string, { object: StoredObject; body: Uint8Array }>();
  constructor(private readonly policy?: FileSecurityPolicy) {}

  async put(input: {
    organizationId: string;
    key?: string;
    body: Uint8Array;
    contentType: string;
    metadata?: Readonly<Record<string, string>>;
  }): Promise<StoredObject> {
    if (input.organizationId === '') throw new ValidationError('Storage organization is required');
    if (this.policy !== undefined) await this.policy.malwareScan?.(input.body);
    const key = input.key ?? randomUUID();
    const object: StoredObject = {
      key,
      organizationId: input.organizationId,
      contentType: input.contentType,
      size: input.body.byteLength,
      etag: randomUUID(),
      createdAt: new Date(),
    };
    this.objects.set(`${input.organizationId}:${key}`, {
      object,
      body: new Uint8Array(input.body),
    });
    return object;
  }
  get(organizationId: string, key: string) {
    const value = this.objects.get(`${organizationId}:${key}`);
    return Promise.resolve(
      value === undefined ? undefined : { object: value.object, body: new Uint8Array(value.body) },
    );
  }
  delete(organizationId: string, key: string) {
    this.objects.delete(`${organizationId}:${key}`);
    return Promise.resolve();
  }
  signedUrl(organizationId: string, key: string, expiresInSeconds: number) {
    if (expiresInSeconds <= 0)
      return Promise.reject(new ValidationError('Signed URL expiry must be positive'));
    if (!this.objects.has(`${organizationId}:${key}`))
      return Promise.reject(new ValidationError('Object not found'));
    return Promise.resolve(
      `memory:///${encodeURIComponent(organizationId)}/${encodeURIComponent(key)}?expires=${String(Math.floor(Date.now() / 1000) + expiresInSeconds)}`,
    );
  }
}

export interface StorageAdapterOptions {
  readonly backend?: StorageProvider;
  readonly endpoint?: string;
}

export interface S3StorageAdapterOptions extends StorageAdapterOptions {
  readonly client?: S3Client;
  readonly bucket?: string;
  readonly keyPrefix?: string;
  readonly signedUrlExpirySeconds?: number;
  readonly signer?: (
    client: S3Client,
    command: GetObjectCommand,
    options: { readonly expiresIn: number },
  ) => Promise<string>;
  readonly providerScheme?: 's3' | 'r2' | 'gs';
}

export interface AzureBlobStorageAdapterOptions extends StorageAdapterOptions {
  readonly client?: BlobServiceClient;
  readonly container?: string;
  readonly keyPrefix?: string;
  readonly signedUrlExpirySeconds?: number;
  readonly sasUrl?: (client: BlockBlobClient, expiresOn: Date) => Promise<string>;
}

/** Adapter-neutral remote boundary; concrete SDKs can replace the injected backend. */
export class RemoteStorageProvider implements StorageProvider {
  protected readonly backend: StorageProvider;
  constructor(
    private readonly scheme: string,
    options: StorageAdapterOptions = {},
  ) {
    this.backend = options.backend ?? new InMemoryStorageProvider();
    if (options.endpoint?.trim() === '')
      throw new ValidationError('Storage endpoint cannot be empty');
  }
  put(input: Parameters<StorageProvider['put']>[0]): Promise<StoredObject> {
    return this.backend.put(input);
  }
  get(organizationId: string, key: string): ReturnType<StorageProvider['get']> {
    return this.backend.get(organizationId, key);
  }
  delete(organizationId: string, key: string): Promise<void> {
    return this.backend.delete(organizationId, key);
  }
  async signedUrl(organizationId: string, key: string, expiresInSeconds: number): Promise<string> {
    const signed = await this.backend.signedUrl(organizationId, key, expiresInSeconds);
    return `${this.scheme}://${signed.replace(/^[^:]+:\/\//u, '')}`;
  }
}

export class LocalStorageProvider extends RemoteStorageProvider {
  constructor(options: StorageAdapterOptions = {}) {
    super('file', options);
  }
}
export class S3StorageProvider extends RemoteStorageProvider {
  private readonly client: S3Client | undefined;
  private readonly bucket: string | undefined;
  private readonly keyPrefix: string;
  private readonly signedUrlExpirySeconds: number;
  private readonly signer: (
    client: S3Client,
    command: GetObjectCommand,
    options: { readonly expiresIn: number },
  ) => Promise<string>;

  constructor(options: S3StorageAdapterOptions = {}) {
    super(options.providerScheme ?? 's3', options);
    this.client = options.client;
    this.bucket = options.bucket;
    this.keyPrefix = options.keyPrefix ?? 'handstack';
    this.signedUrlExpirySeconds = options.signedUrlExpirySeconds ?? 900;
    this.signer =
      options.signer ??
      ((client, command, signerOptions) => getSignedUrl(client, command, signerOptions));
    if ((this.client === undefined) !== (this.bucket === undefined))
      throw new ValidationError('S3 client and bucket must be configured together');
    if (this.signedUrlExpirySeconds <= 0)
      throw new ValidationError('S3 signed URL expiry must be positive');
  }

  override async put(input: Parameters<StorageProvider['put']>[0]): Promise<StoredObject> {
    if (this.client === undefined || this.bucket === undefined) return super.put(input);
    const key = this.objectKey(input.organizationId, input.key ?? randomUUID());
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
        Metadata: input.metadata,
      }),
    );
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return {
      key: this.externalKey(input.organizationId, key),
      organizationId: input.organizationId,
      contentType: head.ContentType ?? input.contentType,
      size: head.ContentLength ?? input.body.byteLength,
      etag: (head.ETag ?? '').replace(/^"|"$/gu, ''),
      createdAt: head.LastModified ?? new Date(),
    };
  }

  override async get(
    organizationId: string,
    key: string,
  ): Promise<{ readonly object: StoredObject; readonly body: Uint8Array } | undefined> {
    if (this.client === undefined || this.bucket === undefined)
      return super.get(organizationId, key);
    const objectKey = this.objectKey(organizationId, key);
    try {
      const [head, response] = await Promise.all([
        this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey })),
        this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey })),
      ]);
      const body =
        response.Body === undefined ? new Uint8Array() : await response.Body.transformToByteArray();
      return {
        object: {
          key,
          organizationId,
          contentType: head.ContentType ?? 'application/octet-stream',
          size: head.ContentLength ?? body.byteLength,
          etag: (head.ETag ?? '').replace(/^"|"$/gu, ''),
          createdAt: head.LastModified ?? new Date(),
        },
        body,
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  override async delete(organizationId: string, key: string): Promise<void> {
    if (this.client === undefined || this.bucket === undefined)
      return super.delete(organizationId, key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(organizationId, key) }),
    );
  }

  override async signedUrl(
    organizationId: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    if (expiresInSeconds <= 0) throw new ValidationError('Signed URL expiry must be positive');
    if (this.client === undefined || this.bucket === undefined)
      return super.signedUrl(organizationId, key, expiresInSeconds);
    const existing = await this.get(organizationId, key);
    if (existing === undefined) throw new ValidationError('Object not found');
    return this.signer(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(organizationId, key) }),
      { expiresIn: Math.min(expiresInSeconds, this.signedUrlExpirySeconds) },
    );
  }

  private objectKey(organizationId: string, key: string): string {
    return `${this.keyPrefix}/${encodeURIComponent(organizationId)}/${key}`;
  }
  private externalKey(organizationId: string, key: string): string {
    return key.slice(`${this.keyPrefix}/${encodeURIComponent(organizationId)}/`.length);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    ((error as { name?: unknown }).name === 'NotFound' ||
      (error as { name?: unknown }).name === 'NoSuchKey')
  );
}
/** Cloudflare R2 uses the S3 API; provide an S3Client configured with the R2 endpoint. */
export class CloudflareR2StorageProvider extends S3StorageProvider {
  constructor(options: S3StorageAdapterOptions = {}) {
    super({ ...options, providerScheme: 'r2' });
  }
}
export class AzureBlobStorageProvider extends RemoteStorageProvider {
  private readonly client: BlobServiceClient | undefined;
  private readonly container: string | undefined;
  private readonly keyPrefix: string;
  private readonly signedUrlExpirySeconds: number;
  private readonly sasUrl: AzureBlobStorageAdapterOptions['sasUrl'];

  constructor(options: AzureBlobStorageAdapterOptions = {}) {
    super('azure-blob', options);
    this.client = options.client;
    this.container = options.container;
    this.keyPrefix = options.keyPrefix ?? 'handstack';
    this.signedUrlExpirySeconds = options.signedUrlExpirySeconds ?? 900;
    this.sasUrl = options.sasUrl;
    if ((this.client === undefined) !== (this.container === undefined))
      throw new ValidationError('Azure Blob client and container must be configured together');
    if (this.signedUrlExpirySeconds <= 0)
      throw new ValidationError('Azure Blob signed URL expiry must be positive');
  }

  override async put(input: Parameters<StorageProvider['put']>[0]): Promise<StoredObject> {
    if (this.client === undefined || this.container === undefined) return super.put(input);
    const key = this.objectKey(input.organizationId, input.key ?? randomUUID());
    const blob = this.client.getContainerClient(this.container).getBlockBlobClient(key);
    await blob.uploadData(input.body, {
      blobHTTPHeaders: { blobContentType: input.contentType },
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    const properties = await blob.getProperties();
    return {
      key: this.externalKey(input.organizationId, key),
      organizationId: input.organizationId,
      contentType: properties.contentType ?? input.contentType,
      size: properties.contentLength ?? input.body.byteLength,
      etag: properties.etag ?? '',
      createdAt: properties.lastModified ?? new Date(),
    };
  }

  override async get(
    organizationId: string,
    key: string,
  ): Promise<{ readonly object: StoredObject; readonly body: Uint8Array } | undefined> {
    if (this.client === undefined || this.container === undefined)
      return super.get(organizationId, key);
    const blob = this.client
      .getContainerClient(this.container)
      .getBlockBlobClient(this.objectKey(organizationId, key));
    try {
      const [properties, body] = await Promise.all([blob.getProperties(), blob.downloadToBuffer()]);
      return {
        object: {
          key,
          organizationId,
          contentType: properties.contentType ?? 'application/octet-stream',
          size: properties.contentLength ?? body.byteLength,
          etag: properties.etag ?? '',
          createdAt: properties.lastModified ?? new Date(),
        },
        body: new Uint8Array(body),
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  override async delete(organizationId: string, key: string): Promise<void> {
    if (this.client === undefined || this.container === undefined)
      return super.delete(organizationId, key);
    await this.client
      .getContainerClient(this.container)
      .getBlockBlobClient(this.objectKey(organizationId, key))
      .deleteIfExists();
  }

  override async signedUrl(
    organizationId: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    if (expiresInSeconds <= 0) throw new ValidationError('Signed URL expiry must be positive');
    if (this.client === undefined || this.container === undefined)
      return super.signedUrl(organizationId, key, expiresInSeconds);
    const blob = this.client
      .getContainerClient(this.container)
      .getBlockBlobClient(this.objectKey(organizationId, key));
    if ((await this.get(organizationId, key)) === undefined)
      throw new ValidationError('Object not found');
    const expiresOn = new Date(
      Date.now() + Math.min(expiresInSeconds, this.signedUrlExpirySeconds) * 1000,
    );
    if (this.sasUrl !== undefined) return this.sasUrl(blob, expiresOn);
    return blob.generateSasUrl({ permissions: BlobSASPermissions.parse('r'), expiresOn });
  }

  private objectKey(organizationId: string, key: string): string {
    return `${this.keyPrefix}/${encodeURIComponent(organizationId)}/${key}`;
  }
  private externalKey(organizationId: string, key: string): string {
    return key.slice(`${this.keyPrefix}/${encodeURIComponent(organizationId)}/`.length);
  }
}
/** GCS XML interoperability uses the S3-compatible client when HMAC credentials are configured. */
export class GcsStorageProvider extends S3StorageProvider {
  constructor(options: S3StorageAdapterOptions = {}) {
    super({ ...options, providerScheme: 'gs' });
  }
}

/** Selects the configured object-storage adapter without executing provider code in the API. */
export function createStorageProvider(input: StorageProviderFactoryOptions): StorageProvider {
  switch (input.adapter) {
    case 'local':
      return new LocalStorageProvider(input.options);
    case 's3':
      return new S3StorageProvider(input.options as S3StorageAdapterOptions | undefined);
    case 'r2':
      return new CloudflareR2StorageProvider(input.options as S3StorageAdapterOptions | undefined);
    case 'azure-blob':
      return new AzureBlobStorageProvider(
        input.options as AzureBlobStorageAdapterOptions | undefined,
      );
    case 'gcs':
      return new GcsStorageProvider(input.options as S3StorageAdapterOptions | undefined);
  }
}
