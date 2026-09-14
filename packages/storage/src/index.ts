import { randomUUID } from 'node:crypto';
import { ValidationError } from '@handstack/shared';

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
  constructor(options: StorageAdapterOptions = {}) {
    super('s3', options);
  }
}
export class CloudflareR2StorageProvider extends RemoteStorageProvider {
  constructor(options: StorageAdapterOptions = {}) {
    super('r2', options);
  }
}
export class AzureBlobStorageProvider extends RemoteStorageProvider {
  constructor(options: StorageAdapterOptions = {}) {
    super('azure-blob', options);
  }
}
export class GcsStorageProvider extends RemoteStorageProvider {
  constructor(options: StorageAdapterOptions = {}) {
    super('gs', options);
  }
}
