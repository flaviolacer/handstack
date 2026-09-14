import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  repositoryName,
  type Repository,
  type RepositoryName,
  type TenantEntity,
} from '@handstack/domain';

export type WebhookEvent =
  | 'agent.completed'
  | 'budget.threshold'
  | 'access.requested'
  | 'access.approved'
  | 'plugin.installed'
  | 'user.created';

export interface WebhookDelivery {
  readonly id: string;
  readonly organizationId: string;
  readonly event: WebhookEvent;
  readonly payload: unknown;
  readonly endpoint: string;
  readonly attempt: number;
  readonly status: 'PENDING' | 'DELIVERED' | 'RETRYING' | 'DEAD_LETTERED';
  readonly signature: string;
  readonly createdAt: Date;
  readonly attempts?: readonly WebhookAttempt[];
  /** Versioned event envelope metadata used by receivers for replay protection. */
  readonly schemaVersion?: string;
  readonly source?: string;
  readonly timestamp?: string;
  readonly keyId?: string;
  readonly lastError?: string;
}

export interface WebhookAttempt {
  readonly attempt: number;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly status: 'PENDING' | 'DELIVERED' | 'FAILED';
  readonly error?: string;
}

export interface WebhookDeliveryEntity extends TenantEntity {
  readonly organizationId: string;
  readonly event: WebhookEvent;
  readonly payload: unknown;
  readonly endpoint: string;
  readonly attempt: number;
  readonly status: WebhookDelivery['status'];
  readonly signature: string;
  readonly attempts?: readonly WebhookAttempt[];
  readonly schemaVersion?: string;
  readonly source?: string;
  readonly timestamp?: string;
  readonly keyId?: string;
  readonly lastError?: string;
}

export interface WebhookTransport {
  send(input: {
    readonly endpoint: string;
    readonly body: string;
    readonly signature: string;
  }): Promise<void>;
}

export interface WebhookMetrics {
  increment(
    name:
      | 'webhook.delivery.attempt'
      | 'webhook.delivery.delivered'
      | 'webhook.delivery.failed'
      | 'webhook.delivery.dead_lettered',
    tags: { organizationId: string; event: WebhookEvent },
  ): void;
}

export interface WebhookAuditSink {
  record(event: {
    readonly type:
      'webhook.attempt' | 'webhook.delivered' | 'webhook.failed' | 'webhook.dead_lettered';
    readonly organizationId: string;
    readonly deliveryId: string;
    readonly event: WebhookEvent;
    readonly attempt: number;
    readonly error?: string;
  }): Promise<void>;
}

const noopAudit: WebhookAuditSink = {
  record: async () => {
    await Promise.resolve();
  },
};

const noopMetrics: WebhookMetrics = {
  increment: () => {
    return;
  },
};

export interface WebhookSecretSet {
  readonly current: string;
  readonly keyId: string;
  readonly previous?: { readonly secret: string; readonly keyId: string; readonly expiresAt: Date };
}

/** Secret-provider boundary; implementations may delegate to Vault/KMS/cloud secret stores. */
export interface WebhookSecretProvider {
  get(organizationId: string): Promise<WebhookSecretSet | undefined>;
  put(
    organizationId: string,
    secret: string,
    keyId?: string,
    overlapMs?: number,
  ): Promise<WebhookSecretSet>;
}

export class InMemoryWebhookSecretProvider implements WebhookSecretProvider {
  private readonly values = new Map<string, WebhookSecretSet>();
  async get(organizationId: string): Promise<WebhookSecretSet | undefined> {
    const value = this.values.get(organizationId);
    if (value?.previous !== undefined && value.previous.expiresAt.getTime() <= Date.now()) {
      const current = { current: value.current, keyId: value.keyId };
      this.values.set(organizationId, current);
      return current;
    }
    return await Promise.resolve(value);
  }
  async put(
    organizationId: string,
    secret: string,
    keyId: string = randomUUID(),
    overlapMs = 300_000,
  ): Promise<WebhookSecretSet> {
    if (secret.length < 16) throw new Error('Webhook secret must contain at least 16 characters');
    const previous = this.values.get(organizationId);
    const next: WebhookSecretSet = {
      current: secret,
      keyId,
      ...(previous === undefined
        ? {}
        : {
            previous: {
              secret: previous.current,
              keyId: previous.keyId,
              expiresAt: new Date(Date.now() + overlapMs),
            },
          }),
    };
    this.values.set(organizationId, next);
    return await Promise.resolve(next);
  }
}

export interface WebhookSecretEntity extends TenantEntity {
  readonly currentCiphertext: string;
  readonly currentKeyId: string;
  readonly previousCiphertext?: string;
  readonly previousKeyId?: string;
  readonly previousExpiresAt?: Date;
}

export interface WebhookEndpoint {
  readonly organizationId: string;
  readonly endpoint: string;
  readonly source?: string;
}

export interface WebhookEndpointEntity extends TenantEntity {
  readonly endpoint: string;
  readonly source?: string;
}

export interface WebhookEndpointStore {
  get(organizationId: string): Promise<WebhookEndpoint | undefined>;
  save(value: WebhookEndpoint): Promise<void>;
}

export class RepositoryWebhookEndpointStore implements WebhookEndpointStore {
  private readonly repository: Repository<WebhookEndpointEntity>;
  constructor(repository: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.repository = repository<WebhookEndpointEntity>(repositoryName('webhook-endpoints'));
  }
  async get(organizationId: string): Promise<WebhookEndpoint | undefined> {
    const page = await this.repository.list(organizationId, { limit: 1 });
    const entity = page.items[0];
    return entity === undefined
      ? undefined
      : {
          organizationId,
          endpoint: entity.endpoint,
          ...(entity.source === undefined ? {} : { source: entity.source }),
        };
  }
  async save(value: WebhookEndpoint): Promise<void> {
    const existing = await this.repository.findById(value.organizationId, value.organizationId);
    const entity: WebhookEndpointEntity = {
      id: value.organizationId,
      tenantId: value.organizationId,
      endpoint: value.endpoint,
      ...(value.source === undefined ? {} : { source: value.source }),
      version: existing === undefined ? 1 : existing.version + 1,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    if (existing === undefined) await this.repository.insert(entity);
    else await this.repository.update(entity, existing.version);
  }
}

/** Repository-backed provider with AES-GCM envelope encryption and key overlap. */
export class RepositoryWebhookSecretProvider implements WebhookSecretProvider {
  private readonly repository: Repository<WebhookSecretEntity>;
  private readonly encryptionKey: Buffer;
  constructor(
    repository: <T extends TenantEntity>(name: RepositoryName) => Repository<T>,
    masterKey: string,
  ) {
    if (masterKey.length < 16) throw new Error('Webhook master key is too short');
    this.repository = repository<WebhookSecretEntity>(repositoryName('webhook-secrets'));
    this.encryptionKey = createHash('sha256').update(masterKey).digest();
  }
  async get(organizationId: string): Promise<WebhookSecretSet | undefined> {
    const page = await this.repository.list(organizationId, { limit: 1 });
    const entity = page.items[0];
    if (entity === undefined) return undefined;
    const previousExpiresAt = entity.previousExpiresAt;
    const previousValid =
      entity.previousCiphertext !== undefined &&
      entity.previousKeyId !== undefined &&
      previousExpiresAt !== undefined &&
      new Date(previousExpiresAt).getTime() > Date.now();
    const result: WebhookSecretSet = {
      current: decryptSecret(entity.currentCiphertext, this.encryptionKey),
      keyId: entity.currentKeyId,
      ...(previousValid
        ? {
            previous: {
              secret: decryptSecret(entity.previousCiphertext, this.encryptionKey),
              keyId: entity.previousKeyId,
              expiresAt: new Date(previousExpiresAt),
            },
          }
        : {}),
    };
    return result;
  }
  async put(
    organizationId: string,
    secret: string,
    keyId: string = randomUUID(),
    overlapMs = 300_000,
  ): Promise<WebhookSecretSet> {
    if (secret.length < 16) throw new Error('Webhook secret must contain at least 16 characters');
    const existing = await this.repository.findById(organizationId, organizationId);
    const next: WebhookSecretEntity = {
      id: organizationId,
      tenantId: organizationId,
      currentCiphertext: encryptSecret(secret, this.encryptionKey),
      currentKeyId: keyId,
      version: existing === undefined ? 1 : existing.version + 1,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
      ...(existing === undefined
        ? {}
        : {
            previousCiphertext: existing.currentCiphertext,
            previousKeyId: existing.currentKeyId,
            previousExpiresAt: new Date(Date.now() + overlapMs),
          }),
    };
    if (existing === undefined) await this.repository.insert(next);
    else await this.repository.update(next, existing.version);
    return {
      current: secret,
      keyId,
      ...(existing === undefined
        ? {}
        : {
            previous: {
              secret: decryptSecret(existing.currentCiphertext, this.encryptionKey),
              keyId: existing.currentKeyId,
              expiresAt: new Date(Date.now() + overlapMs),
            },
          }),
    };
  }
}

/** Durable boundary for delivery idempotency and terminal state. */
export interface WebhookDeliveryStore {
  get(id: string, organizationId?: string): Promise<WebhookDelivery | undefined>;
  save(delivery: WebhookDelivery): Promise<void>;
  list(
    organizationId: string,
    status?: WebhookDelivery['status'],
  ): Promise<readonly WebhookDelivery[]>;
  listDeadLettered(organizationId?: string): Promise<readonly WebhookDelivery[]>;
  prune(before: Date, organizationId?: string): Promise<number>;
}

export class InMemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly deliveries = new Map<string, WebhookDelivery>();
  async get(id: string, organizationId?: string): Promise<WebhookDelivery | undefined> {
    const value = this.deliveries.get(id);
    return await Promise.resolve(
      value === undefined ||
        (organizationId !== undefined && value.organizationId !== organizationId)
        ? undefined
        : value,
    );
  }
  async save(delivery: WebhookDelivery): Promise<void> {
    this.deliveries.set(delivery.id, delivery);
    await Promise.resolve();
  }
  async list(
    organizationId: string,
    status?: WebhookDelivery['status'],
  ): Promise<readonly WebhookDelivery[]> {
    return await Promise.resolve(
      [...this.deliveries.values()].filter(
        (item) =>
          item.organizationId === organizationId &&
          (status === undefined || item.status === status),
      ),
    );
  }
  async listDeadLettered(organizationId?: string): Promise<readonly WebhookDelivery[]> {
    return organizationId === undefined ? [] : await this.list(organizationId, 'DEAD_LETTERED');
  }
  async prune(before: Date, organizationId?: string): Promise<number> {
    let count = 0;
    for (const [id, delivery] of this.deliveries) {
      if (
        delivery.createdAt < before &&
        (organizationId === undefined || delivery.organizationId === organizationId)
      ) {
        this.deliveries.delete(id);
        count += 1;
      }
    }
    return await Promise.resolve(count);
  }
}

/** Repository-backed store; dates and versions stay in the canonical entity contract. */
export class RepositoryWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly repository: Repository<WebhookDeliveryEntity>;
  constructor(repository: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.repository = repository<WebhookDeliveryEntity>(repositoryName('webhook-deliveries'));
  }
  async get(id: string, organizationId?: string): Promise<WebhookDelivery | undefined> {
    if (organizationId === undefined) return undefined;
    const page = await this.repository.list(organizationId, { limit: 200 });
    const entity = page.items.find((item) => item.id === id);
    return entity === undefined ? undefined : toDelivery(entity);
  }
  async save(delivery: WebhookDelivery): Promise<void> {
    const current = await this.repository.findById(delivery.organizationId, delivery.id);
    const now = new Date();
    const entity: WebhookDeliveryEntity = {
      ...delivery,
      tenantId: delivery.organizationId,
      version: current === undefined ? 1 : current.version + 1,
      createdAt: current?.createdAt ?? delivery.createdAt,
      updatedAt: now,
    };
    if (current === undefined) await this.repository.insert(entity);
    else await this.repository.update(entity, current.version);
  }
  async list(
    organizationId: string,
    status?: WebhookDelivery['status'],
  ): Promise<readonly WebhookDelivery[]> {
    const deliveries: WebhookDelivery[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.repository.list(organizationId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      deliveries.push(
        ...page.items
          .filter((item) => status === undefined || item.status === status)
          .map(toDelivery),
      );
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return deliveries;
  }
  async listDeadLettered(organizationId?: string): Promise<readonly WebhookDelivery[]> {
    return organizationId === undefined ? [] : await this.list(organizationId, 'DEAD_LETTERED');
  }
  async prune(before: Date, organizationId?: string): Promise<number> {
    if (organizationId === undefined) return 0;
    const page = await this.repository.list(organizationId, { limit: 200 });
    let count = 0;
    for (const item of page.items) {
      if (new Date(item.createdAt).getTime() < before.getTime()) {
        if (await this.repository.delete(organizationId, item.id, item.version)) count += 1;
      }
    }
    return count;
  }
}

function toDelivery(entity: WebhookDeliveryEntity): WebhookDelivery {
  return {
    id: entity.id,
    organizationId: entity.organizationId,
    event: entity.event,
    payload: entity.payload,
    endpoint: entity.endpoint,
    attempt: entity.attempt,
    status: entity.status,
    signature: entity.signature,
    createdAt: entity.createdAt,
    ...(entity.attempts === undefined
      ? {}
      : {
          attempts: entity.attempts.map((attempt) => ({
            ...attempt,
            startedAt: new Date(attempt.startedAt),
            ...(attempt.finishedAt === undefined
              ? {}
              : { finishedAt: new Date(attempt.finishedAt) }),
          })),
        }),
    ...(entity.schemaVersion === undefined ? {} : { schemaVersion: entity.schemaVersion }),
    ...(entity.source === undefined ? {} : { source: entity.source }),
    ...(entity.timestamp === undefined ? {} : { timestamp: entity.timestamp }),
    ...(entity.keyId === undefined ? {} : { keyId: entity.keyId }),
    ...(entity.lastError === undefined ? {} : { lastError: entity.lastError }),
  };
}

export interface WebhookDispatcherOptions {
  readonly secret: string;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly transport: WebhookTransport;
  readonly store?: WebhookDeliveryStore;
  /** Maximum canonical envelope size in bytes (default 256 KiB). */
  readonly maxPayloadBytes?: number;
  /** Random jitter fraction applied to exponential retry delays (default 0.2). */
  readonly retryJitter?: number;
  readonly keyId?: string;
  readonly source?: string;
  readonly retentionMs?: number;
  readonly metrics?: WebhookMetrics;
  readonly audit?: WebhookAuditSink;
  readonly allowedEndpointHosts?: readonly string[];
}

export class WebhookDispatcher {
  private readonly deliveries = new Map<string, WebhookDelivery>();
  private readonly deadLetters: WebhookDelivery[] = [];
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly store: WebhookDeliveryStore;
  private readonly maxPayloadBytes: number;
  private readonly retryJitter: number;
  private readonly retentionMs: number;
  private readonly metrics: WebhookMetrics;
  private readonly audit: WebhookAuditSink;

  constructor(private readonly options: WebhookDispatcherOptions) {
    if (options.secret.length < 16)
      throw new Error('Webhook secret must contain at least 16 characters');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 100;
    this.store = options.store ?? new InMemoryWebhookDeliveryStore();
    this.maxPayloadBytes = options.maxPayloadBytes ?? 256 * 1024;
    this.retryJitter = options.retryJitter ?? 0.2;
    this.retentionMs = options.retentionMs ?? 30 * 86_400_000;
    this.metrics = options.metrics ?? noopMetrics;
    this.audit = options.audit ?? noopAudit;
    if (this.maxAttempts < 1 || this.maxAttempts > 10)
      throw new Error('Invalid webhook attempt limit');
    if (!Number.isInteger(this.maxPayloadBytes) || this.maxPayloadBytes < 1024)
      throw new Error('Invalid webhook payload limit');
    if (this.retryJitter < 0 || this.retryJitter > 1)
      throw new Error('Invalid webhook retry jitter');
  }

  async dispatch(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly event: WebhookEvent;
    readonly payload: unknown;
    readonly endpoint: string;
    readonly schemaVersion?: string;
    readonly source?: string;
    readonly timestamp?: string;
    readonly keyId?: string;
  }): Promise<WebhookDelivery> {
    return await this.dispatchInternal(input, false);
  }

  /** Replay a dead-letter delivery after operator remediation. The id remains stable for deduplication. */
  async replay(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly event: WebhookEvent;
    readonly payload: unknown;
    readonly endpoint: string;
    readonly schemaVersion?: string;
    readonly source?: string;
    readonly timestamp?: string;
    readonly keyId?: string;
  }): Promise<WebhookDelivery> {
    return await this.dispatchInternal(input, true);
  }

  private async dispatchInternal(
    input: {
      readonly id: string;
      readonly organizationId: string;
      readonly event: WebhookEvent;
      readonly payload: unknown;
      readonly endpoint: string;
      readonly schemaVersion?: string;
      readonly source?: string;
      readonly timestamp?: string;
      readonly keyId?: string;
    },
    force: boolean,
  ): Promise<WebhookDelivery> {
    verifyEndpoint(input.endpoint, this.options.allowedEndpointHosts);
    const timestamp = input.timestamp ?? new Date().toISOString();
    const envelope = {
      id: input.id,
      schemaVersion: input.schemaVersion ?? '1.0',
      organizationId: input.organizationId,
      source: input.source ?? this.options.source ?? 'handstack',
      event: input.event,
      timestamp,
      payload: redactPayload(input.payload),
    };
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body, 'utf8') > this.maxPayloadBytes)
      throw new Error('Webhook payload exceeds configured size limit');
    const previous =
      this.deliveries.get(input.id) ?? (await this.store.get(input.id, input.organizationId));
    if (
      previous !== undefined &&
      !force &&
      (previous.status === 'DELIVERED' || previous.status === 'DEAD_LETTERED')
    )
      return previous;
    const signature = sign(body, this.options.secret);
    const metadata = {
      schemaVersion: envelope.schemaVersion,
      source: envelope.source,
      timestamp,
      ...((input.keyId ?? this.options.keyId) === undefined
        ? {}
        : { keyId: input.keyId ?? this.options.keyId }),
    };
    let lastError: string | undefined;
    let attempts: WebhookAttempt[] = [...(previous?.attempts ?? [])];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const startedAt = new Date();
      this.metrics.increment('webhook.delivery.attempt', {
        organizationId: input.organizationId,
        event: input.event,
      });
      await this.audit.record({
        type: 'webhook.attempt',
        organizationId: input.organizationId,
        deliveryId: input.id,
        event: input.event,
        attempt,
      });
      const attemptLog: WebhookAttempt = { attempt, startedAt, status: 'PENDING' };
      attempts = [...attempts, attemptLog];
      const pending: WebhookDelivery = {
        ...input,
        ...metadata,
        payload: envelope.payload,
        attempt,
        status: 'PENDING',
        signature,
        createdAt: previous?.createdAt ?? startedAt,
        attempts,
      };
      await this.store.save(pending);
      try {
        await this.options.transport.send({ endpoint: input.endpoint, body, signature });
        attempts = [
          ...attempts.slice(0, -1),
          { ...attemptLog, status: 'DELIVERED', finishedAt: new Date() },
        ];
        const delivered: WebhookDelivery = { ...pending, status: 'DELIVERED', attempts };
        this.deliveries.set(input.id, delivered);
        this.metrics.increment('webhook.delivery.delivered', {
          organizationId: input.organizationId,
          event: input.event,
        });
        await this.audit.record({
          type: 'webhook.delivered',
          organizationId: input.organizationId,
          deliveryId: input.id,
          event: input.event,
          attempt,
        });
        await this.store.save(delivered);
        return delivered;
      } catch (error) {
        lastError = redactError(
          error instanceof Error ? error.message : 'Webhook delivery failed',
          this.options.secret,
        );
        this.metrics.increment('webhook.delivery.failed', {
          organizationId: input.organizationId,
          event: input.event,
        });
        await this.audit.record({
          type: 'webhook.failed',
          organizationId: input.organizationId,
          deliveryId: input.id,
          event: input.event,
          attempt,
          error: lastError,
        });
        attempts = [
          ...attempts.slice(0, -1),
          { ...attemptLog, status: 'FAILED', finishedAt: new Date(), error: lastError },
        ];
        await this.store.save({ ...pending, attempts, lastError });
        if (attempt < this.maxAttempts && this.retryBaseMs > 0) {
          const base = this.retryBaseMs * 2 ** (attempt - 1);
          const jitter = base * this.retryJitter * Math.random();
          await new Promise<void>((resolve) => setTimeout(resolve, base + jitter));
        }
      }
    }
    const dead: WebhookDelivery = {
      ...input,
      ...metadata,
      payload: envelope.payload,
      attempt: this.maxAttempts,
      status: 'DEAD_LETTERED',
      signature,
      createdAt: previous?.createdAt ?? new Date(),
      attempts,
      ...(lastError === undefined ? {} : { lastError }),
    };
    this.deliveries.set(input.id, dead);
    this.metrics.increment('webhook.delivery.dead_lettered', {
      organizationId: input.organizationId,
      event: input.event,
    });
    await this.audit.record({
      type: 'webhook.dead_lettered',
      organizationId: input.organizationId,
      deliveryId: input.id,
      event: input.event,
      attempt: this.maxAttempts,
      ...(lastError === undefined ? {} : { error: lastError }),
    });
    await this.store.save(dead);
    this.deadLetters.push(dead);
    return dead;
  }

  get(id: string): WebhookDelivery | undefined {
    return this.deliveries.get(id);
  }
  get deadLettered(): readonly WebhookDelivery[] {
    return [...this.deadLetters];
  }
  async prune(organizationId?: string): Promise<number> {
    return await this.store.prune(new Date(Date.now() - this.retentionMs), organizationId);
  }
}

export interface WebhookDispatchJob {
  readonly id: string;
  readonly organizationId: string;
  readonly event: WebhookEvent;
  readonly payload: unknown;
  readonly endpoint: string;
}

export interface WebhookWorkerQueue {
  dequeue(): Promise<WebhookDispatchJob | undefined>;
  complete(job: WebhookDispatchJob, delivery: WebhookDelivery): Promise<void>;
  retry(job: WebhookDispatchJob, error: unknown): Promise<void>;
  deadLetter(job: WebhookDispatchJob, error: unknown): Promise<void>;
}

/** One-shot worker boundary; schedulers can call runOnce in a durable loop. */
export class WebhookDeliveryWorker {
  constructor(
    private readonly queue: WebhookWorkerQueue,
    private readonly resolveDispatcher: (organizationId: string) => Promise<WebhookDispatcher>,
  ) {}

  async runOnce(): Promise<'IDLE' | 'DELIVERED' | 'RETRYING' | 'DEAD_LETTERED'> {
    const job = await this.queue.dequeue();
    if (job === undefined) return 'IDLE';
    try {
      const dispatcher = await this.resolveDispatcher(job.organizationId);
      const delivery = await dispatcher.dispatch(job);
      if (delivery.status === 'DEAD_LETTERED') {
        await this.queue.deadLetter(job, delivery.lastError ?? 'Webhook delivery failed');
        return 'DEAD_LETTERED';
      }
      await this.queue.complete(job, delivery);
      return 'DELIVERED';
    } catch (error) {
      await this.queue.retry(job, error);
      return 'RETRYING';
    }
  }
}

export interface WebhookTenantSource {
  listOrganizations(): Promise<readonly string[]>;
}

/** Scheduled retention worker; an external scheduler invokes runOnce. */
export class WebhookRetentionWorker {
  constructor(
    private readonly tenants: WebhookTenantSource,
    private readonly resolveDispatcher: (organizationId: string) => Promise<WebhookDispatcher>,
  ) {}

  async runOnce(): Promise<number> {
    const organizations = await this.tenants.listOrganizations();
    let removed = 0;
    for (const organizationId of organizations) {
      removed += await (await this.resolveDispatcher(organizationId)).prune(organizationId);
    }
    return removed;
  }
}

export function signWebhookBody(body: string, secret: string): string {
  return sign(body, secret);
}

export function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  const expected = sign(body, secret);
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyWebhookSignatureWithRotation(
  body: string,
  signature: string,
  secrets: WebhookSecretSet,
  now = new Date(),
): string | undefined {
  if (verifyWebhookSignature(body, signature, secrets.current)) return secrets.keyId;
  if (
    secrets.previous !== undefined &&
    secrets.previous.expiresAt.getTime() > now.getTime() &&
    verifyWebhookSignature(body, signature, secrets.previous.secret)
  ) {
    return secrets.previous.keyId;
  }
  return undefined;
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function verifyEndpoint(endpoint: string, allowedHosts?: readonly string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Webhook endpoint must be a valid URL');
  }
  if (
    parsed.protocol !== 'https:' &&
    !(
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    )
  ) {
    throw new Error('Webhook endpoint must use HTTPS');
  }
  if (allowedHosts !== undefined && !allowedHosts.includes(parsed.hostname))
    throw new Error('Webhook endpoint host is not allowed');
}

/** Redact obvious credential fields before signing/persisting a payload. */
function redactPayload(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactPayload);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = /token|secret|password|api[-_]?key|credential/i.test(key)
      ? '[REDACTED]'
      : redactPayload(item);
  }
  return result;
}

function redactError(message: string, secret: string): string {
  return message.replaceAll(secret, '[REDACTED]').slice(0, 500);
}

function encryptSecret(secret: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decryptSecret(encoded: string, key: Buffer): string {
  const [ivEncoded, tagEncoded, ciphertextEncoded] = encoded.split('.');
  if (ivEncoded === undefined || tagEncoded === undefined || ciphertextEncoded === undefined)
    throw new Error('Invalid encrypted webhook secret');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivEncoded, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
