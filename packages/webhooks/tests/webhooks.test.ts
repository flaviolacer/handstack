import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Page, Repository, RepositoryName, TenantEntity } from '@handstack/domain';
import { MasterKey } from '@handstack/core';
import {
  InMemoryWebhookDeliveryStore,
  InMemoryWebhookSecretProvider,
  RepositoryWebhookDeliveryStore,
  RepositoryWebhookEndpointStore,
  RepositoryWebhookSecretProvider,
  signWebhookBody,
  WebhookDeliveryWorker,
  WebhookDispatcher,
  WebhookRetentionWorker,
  verifyWebhookSignature,
  verifyWebhookSignatureWithRotation,
  type WebhookDeliveryEntity,
  type WebhookDispatchJob,
  type WebhookEndpointEntity,
  type WebhookSecretEntity,
  type WebhookWorkerQueue,
} from '../src/index.js';

describe('WebhookDispatcher', () => {
  it('signs deliveries and retries transient failures', async () => {
    let attempts = 0;
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      retryBaseMs: 0,
      transport: {
        send: ({ body, signature }) => {
          attempts += 1;
          expect(verifyWebhookSignature(body, signature, '1234567890123456')).toBe(true);
          if (attempts === 1) return Promise.reject(new Error('temporary'));
          return Promise.resolve();
        },
      },
    });
    await expect(
      dispatcher.dispatch({
        id: 'd1',
        organizationId: 'org',
        event: 'agent.completed',
        payload: { ok: true },
        endpoint: 'https://example.test/hook',
      }),
    ).resolves.toMatchObject({
      status: 'DELIVERED',
      attempt: 2,
      attempts: [
        { attempt: 1, status: 'FAILED' },
        { attempt: 2, status: 'DELIVERED' },
      ],
    });
  });

  it('retains poison deliveries in a dead-letter collection', async () => {
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      maxAttempts: 2,
      retryBaseMs: 0,
      transport: { send: () => Promise.reject(new Error('poison')) },
    });
    const delivery = await dispatcher.dispatch({
      id: 'd2',
      organizationId: 'org',
      event: 'budget.threshold',
      payload: {},
      endpoint: 'https://example.test/hook',
    });
    expect(delivery.status).toBe('DEAD_LETTERED');
    expect(dispatcher.deadLettered).toHaveLength(1);
  });

  it('does not resend an already completed delivery id', async () => {
    let sends = 0;
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      retryBaseMs: 0,
      transport: {
        send: () => {
          sends += 1;
          return Promise.resolve();
        },
      },
    });
    const input = {
      id: 'same',
      organizationId: 'org',
      event: 'user.created' as const,
      payload: {},
      endpoint: 'https://example.test/hook',
    };
    await dispatcher.dispatch(input);
    await dispatcher.dispatch(input);
    expect(sends).toBe(1);
  });

  it('uses the delivery store for idempotency across dispatcher instances', async () => {
    let sends = 0;
    const store = new InMemoryWebhookDeliveryStore();
    const input = {
      id: 'durable',
      organizationId: 'org',
      event: 'user.created' as const,
      payload: {},
      endpoint: 'https://example.test/hook',
    };
    const options = {
      secret: '1234567890123456',
      retryBaseMs: 0,
      store,
      transport: {
        send: () => {
          sends += 1;
          return Promise.resolve();
        },
      },
    };
    await new WebhookDispatcher(options).dispatch(input);
    await expect(new WebhookDispatcher(options).dispatch(input)).resolves.toMatchObject({
      status: 'DELIVERED',
    });
    expect(sends).toBe(1);
  });

  it('maps terminal deliveries through the canonical repository contract', async () => {
    const rows = new Map<string, WebhookDeliveryEntity>();
    const repository: Repository<WebhookDeliveryEntity> = {
      findById: async (_tenant: string, id: string) => await Promise.resolve(rows.get(id)),
      list: async (tenant: string): Promise<Page<WebhookDeliveryEntity>> =>
        await Promise.resolve({
          items: [...rows.values()].filter((item) => item.tenantId === tenant),
        }),
      insert: async (entity: WebhookDeliveryEntity) => {
        rows.set(entity.id, entity);
        return await Promise.resolve(entity);
      },
      update: async (entity: WebhookDeliveryEntity) => {
        rows.set(entity.id, entity);
        return await Promise.resolve(entity);
      },
      delete: async () => await Promise.resolve(true),
    };
    const repositoryFactory = <T extends TenantEntity>(name: RepositoryName): Repository<T> => {
      if (name.length === 0) throw new Error('repository name required');
      return repository as unknown as Repository<T>;
    };
    const store = new RepositoryWebhookDeliveryStore(repositoryFactory);
    const input = {
      id: 'repo-delivery',
      organizationId: 'org',
      event: 'user.created' as const,
      payload: { ok: true },
      endpoint: 'https://example.test/hook',
    };
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      retryBaseMs: 0,
      store,
      transport: { send: () => Promise.resolve() },
    });
    await dispatcher.dispatch(input);
    await expect(store.get(input.id, input.organizationId)).resolves.toMatchObject({
      id: input.id,
      status: 'DELIVERED',
    });
    await expect(store.list('org', 'DELIVERED')).resolves.toHaveLength(1);
    await expect(store.list('other')).resolves.toHaveLength(0);
  });

  it('emits a versioned, timestamped envelope and redacts credentials', async () => {
    let sentBody = '';
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      retryBaseMs: 0,
      keyId: 'key-1',
      source: 'api',
      transport: {
        send: ({ body }) => {
          sentBody = body;
          return Promise.resolve();
        },
      },
    });
    const delivery = await dispatcher.dispatch({
      id: 'metadata',
      organizationId: 'org',
      event: 'user.created',
      payload: { user: 'u1', apiKey: 'do-not-send' },
      endpoint: 'https://example.test/hook',
    });
    const envelope = JSON.parse(sentBody) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe('1.0');
    expect(envelope.source).toBe('api');
    expect(typeof envelope.timestamp).toBe('string');
    expect((envelope.payload as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    expect(delivery.keyId).toBe('key-1');
    expect(verifyWebhookSignature(sentBody, delivery.signature, '1234567890123456')).toBe(true);
  });

  it('rejects insecure endpoints and oversized payloads before transport', async () => {
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      maxPayloadBytes: 1024,
      retryBaseMs: 0,
      transport: { send: () => Promise.resolve() },
    });
    await expect(
      dispatcher.dispatch({
        id: 'insecure',
        organizationId: 'org',
        event: 'user.created',
        payload: {},
        endpoint: 'http://example.test/hook',
      }),
    ).rejects.toThrow(/HTTPS/);
    await expect(
      dispatcher.dispatch({
        id: 'large',
        organizationId: 'org',
        event: 'user.created',
        payload: { value: 'x'.repeat(2_000) },
        endpoint: 'https://example.test/hook',
      }),
    ).rejects.toThrow(/size limit/);
    const restricted = new WebhookDispatcher({
      secret: '1234567890123456',
      allowedEndpointHosts: ['hooks.example.test'],
      transport: { send: () => Promise.resolve() },
    });
    await expect(
      restricted.dispatch({
        id: 'host',
        organizationId: 'org',
        event: 'user.created',
        payload: {},
        endpoint: 'https://other.example.test/hook',
      }),
    ).rejects.toThrow(/not allowed/);
  });

  it('supports explicit operator replay of a dead-letter delivery', async () => {
    let healthy = false;
    let sends = 0;
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      maxAttempts: 1,
      retryBaseMs: 0,
      transport: {
        send: () => {
          sends += 1;
          return healthy ? Promise.resolve() : Promise.reject(new Error('offline'));
        },
      },
    });
    const input = {
      id: 'replay-1',
      organizationId: 'org',
      event: 'user.created' as const,
      payload: {},
      endpoint: 'https://example.test/hook',
    };
    await expect(dispatcher.dispatch(input)).resolves.toMatchObject({ status: 'DEAD_LETTERED' });
    healthy = true;
    await expect(dispatcher.replay(input)).resolves.toMatchObject({
      id: input.id,
      status: 'DELIVERED',
      attempt: 1,
    });
    expect(sends).toBe(2);
  });

  it('rotates secrets with a bounded overlap window', async () => {
    const provider = new InMemoryWebhookSecretProvider();
    await expect(provider.put('org', 'short')).rejects.toThrow(/at least 16/);
    const first = await provider.put('org', '1234567890123456', 'k1');
    const second = await provider.put('org', '6543210987654321', 'k2', 1);
    expect(first.keyId).toBe('k1');
    expect(second.previous?.keyId).toBe('k1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(provider.get('org')).resolves.toMatchObject({
      current: '6543210987654321',
      keyId: 'k2',
    });
  });

  it('encrypts repository-backed secrets and restores them across provider instances', async () => {
    const rows = new Map<string, WebhookSecretEntity>();
    const repository: Repository<WebhookSecretEntity> = {
      findById: async (_tenant, id) => await Promise.resolve(rows.get(id)),
      list: async (tenant) =>
        await Promise.resolve({
          items: [...rows.values()].filter((item) => item.tenantId === tenant),
        }),
      insert: async (entity) => {
        rows.set(entity.id, entity);
        return await Promise.resolve(entity);
      },
      update: async (entity) => {
        rows.set(entity.id, entity);
        return await Promise.resolve(entity);
      },
      delete: async () => await Promise.resolve(true),
    };
    const factory = <T extends TenantEntity>(name: RepositoryName): Repository<T> => {
      if (name.length === 0) throw new Error('repository required');
      return repository as unknown as Repository<T>;
    };
    const masterKey = MasterKey.decode('a'.repeat(64));
    const first = new RepositoryWebhookSecretProvider(factory, masterKey);
    await first.put('org', '1234567890123456', '11111111-1111-4111-8111-111111111111');
    expect(rows.get('org')?.currentCiphertext).toMatch(/^hs-aes256gcm-v1\./u);
    const second = new RepositoryWebhookSecretProvider(factory, masterKey);
    await expect(second.get('org')).resolves.toMatchObject({
      current: '1234567890123456',
      keyId: '11111111-1111-4111-8111-111111111111',
    });
    expect(rows.get('org')?.currentCiphertext).not.toContain('1234567890123456');
  });

  it('migrates legacy webhook ciphertext to HANDSTACK_MASTER_KEY on read', async () => {
    const rows = new Map<string, WebhookSecretEntity>();
    const now = new Date();
    const legacyMasterKey = 'legacy-webhook-master-key-for-tests';
    rows.set('org', {
      id: 'org',
      tenantId: 'org',
      currentCiphertext: encryptLegacyWebhookSecret('current-signing-secret', legacyMasterKey),
      currentKeyId: 'current-key',
      previousCiphertext: encryptLegacyWebhookSecret('previous-signing-secret', legacyMasterKey),
      previousKeyId: 'previous-key',
      previousExpiresAt: new Date(now.getTime() + 60_000),
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const repository: Repository<WebhookSecretEntity> = {
      findById: async (_tenant, id) => await Promise.resolve(rows.get(id)),
      list: async (tenant) =>
        await Promise.resolve({
          items: [...rows.values()].filter((item) => item.tenantId === tenant),
        }),
      insert: async (entity) => {
        rows.set(entity.id, entity);
        return await Promise.resolve(entity);
      },
      update: async (entity) => {
        rows.set(entity.id, entity);
        return await Promise.resolve(entity);
      },
      delete: async () => await Promise.resolve(true),
    };
    const factory = <T extends TenantEntity>(name: RepositoryName): Repository<T> => {
      if (name.length === 0) throw new Error('repository required');
      return repository as unknown as Repository<T>;
    };
    const masterKey = MasterKey.decode('b'.repeat(64));
    const accesses: { organizationId: string; keyId: string }[] = [];
    const migrating = new RepositoryWebhookSecretProvider(
      factory,
      masterKey,
      legacyMasterKey,
      (access) => {
        accesses.push(access);
        return Promise.resolve();
      },
    );

    await expect(migrating.get('org')).resolves.toMatchObject({
      current: 'current-signing-secret',
      previous: { secret: 'previous-signing-secret', keyId: 'previous-key' },
    });
    expect(accesses).toEqual([
      { organizationId: 'org', keyId: 'current-key' },
      { organizationId: 'org', keyId: 'previous-key' },
    ]);
    const migrated = rows.get('org');
    expect(migrated?.version).toBe(2);
    expect(migrated?.currentCiphertext).toMatch(/^hs-aes256gcm-v1\./u);
    expect(migrated?.previousCiphertext).toMatch(/^hs-aes256gcm-v1\./u);
    expect(migrated?.currentCiphertext).not.toContain('current-signing-secret');
    await expect(
      new RepositoryWebhookSecretProvider(factory, masterKey).get('org'),
    ).resolves.toMatchObject({
      current: 'current-signing-secret',
      previous: { secret: 'previous-signing-secret' },
    });
    const current = rows.get('org');
    if (current === undefined) throw new Error('Expected migrated webhook secret');
    rows.set('org', { ...current, previousExpiresAt: new Date(Date.now() - 1) });
    await migrating.get('org');
    expect(rows.get('org')).not.toHaveProperty('previousCiphertext');
    expect(rows.get('org')).not.toHaveProperty('previousKeyId');
  });

  it('persists tenant endpoint configuration independently from secrets', async () => {
    const rows = new Map<string, WebhookEndpointEntity>();
    const repository: Repository<WebhookEndpointEntity> = {
      findById: async (_tenant, id) => await Promise.resolve(rows.get(id)),
      list: async (tenant) =>
        await Promise.resolve({
          items: [...rows.values()].filter((item) => item.tenantId === tenant),
        }),
      insert: async (entity) => {
        rows.set(entity.id, entity);
        return await Promise.resolve(entity);
      },
      update: async (entity) => {
        rows.set(entity.id, entity);
        return await Promise.resolve(entity);
      },
      delete: async () => await Promise.resolve(true),
    };
    const factory = <T extends TenantEntity>(name: RepositoryName): Repository<T> => {
      if (name.length === 0) throw new Error('repository required');
      return repository as unknown as Repository<T>;
    };
    const store = new RepositoryWebhookEndpointStore(factory);
    await store.save({
      organizationId: 'org',
      endpoint: 'https://example.test/hook',
      source: 'api',
    });
    await expect(store.get('org')).resolves.toEqual({
      organizationId: 'org',
      endpoint: 'https://example.test/hook',
      source: 'api',
    });
  });

  it('processes worker jobs with explicit completion and retry/dead-letter outcomes', async () => {
    const job: WebhookDispatchJob = {
      id: 'worker-1',
      organizationId: 'org',
      event: 'user.created',
      payload: {},
      endpoint: 'https://example.test/hook',
    };
    const completed: string[] = [];
    const queue: WebhookWorkerQueue = {
      dequeue: async () => await Promise.resolve(completed.length === 0 ? job : undefined),
      complete: async () => {
        completed.push('complete');
        await Promise.resolve();
      },
      retry: async () => {
        completed.push('retry');
        await Promise.resolve();
      },
      deadLetter: async () => {
        completed.push('dead');
        await Promise.resolve();
      },
    };
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      retryBaseMs: 0,
      transport: { send: () => Promise.resolve() },
    });
    const worker = new WebhookDeliveryWorker(queue, async () => await Promise.resolve(dispatcher));
    await expect(worker.runOnce()).resolves.toBe('DELIVERED');
    await expect(worker.runOnce()).resolves.toBe('IDLE');
    expect(completed).toEqual(['complete']);
  });

  it('prunes only expired deliveries within the requested tenant', async () => {
    const store = new InMemoryWebhookDeliveryStore();
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      retryBaseMs: 0,
      retentionMs: 1,
      transport: { send: () => Promise.resolve() },
      store,
    });
    await dispatcher.dispatch({
      id: 'old',
      organizationId: 'org',
      event: 'user.created',
      payload: {},
      endpoint: 'https://example.test/hook',
    });
    await expect(dispatcher.prune('other')).resolves.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(dispatcher.prune('org')).resolves.toBe(1);
    await expect(store.get('old', 'org')).resolves.toBeUndefined();
  });

  it('runs retention across the tenant source without cross-tenant deletes', async () => {
    const store = new InMemoryWebhookDeliveryStore();
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      retryBaseMs: 0,
      retentionMs: 1,
      transport: { send: () => Promise.resolve() },
      store,
    });
    await dispatcher.dispatch({
      id: 'old',
      organizationId: 'org',
      event: 'user.created',
      payload: {},
      endpoint: 'https://example.test/hook',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const worker = new WebhookRetentionWorker(
      { listOrganizations: async () => await Promise.resolve(['org']) },
      async () => await Promise.resolve(dispatcher),
    );
    await expect(worker.runOnce()).resolves.toBe(1);
  });

  it('emits bounded delivery metrics with tenant and event labels', async () => {
    const names: string[] = [];
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      retryBaseMs: 0,
      maxAttempts: 1,
      metrics: {
        increment: (name) => {
          names.push(name);
        },
      },
      transport: { send: () => Promise.reject(new Error('offline')) },
    });
    await dispatcher.dispatch({
      id: 'metric',
      organizationId: 'org',
      event: 'user.created',
      payload: {},
      endpoint: 'https://example.test/hook',
    });
    expect(names).toEqual([
      'webhook.delivery.attempt',
      'webhook.delivery.failed',
      'webhook.delivery.dead_lettered',
    ]);
  });

  it('writes tenant-scoped audit events for each attempt and terminal outcome', async () => {
    const events: string[] = [];
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      retryBaseMs: 0,
      maxAttempts: 1,
      audit: {
        record: async (event) => {
          events.push(event.type);
          await Promise.resolve();
        },
      },
      transport: { send: () => Promise.reject(new Error('offline')) },
    });
    await dispatcher.dispatch({
      id: 'audit',
      organizationId: 'org',
      event: 'user.created',
      payload: {},
      endpoint: 'https://example.test/hook',
    });
    expect(events).toEqual(['webhook.attempt', 'webhook.failed', 'webhook.dead_lettered']);
  });

  it('propagates bounded execution context only to audit events', async () => {
    const auditEvents: unknown[] = [];
    const dispatcher = new WebhookDispatcher({
      secret: '1234567890123456',
      retryBaseMs: 0,
      maxAttempts: 1,
      audit: {
        record: async (event) => {
          auditEvents.push(event);
          await Promise.resolve();
        },
      },
      transport: { send: () => Promise.resolve() },
    });
    await dispatcher.dispatch({
      id: 'audit-context',
      organizationId: 'org',
      event: 'user.created',
      payload: { secret: 'must-not-be-in-audit-context' },
      endpoint: 'https://example.test/hook',
      context: {
        requestId: 'request-webhook',
        traceId: 'trace-webhook',
        principalId: 'principal-webhook',
        source: 'API',
      },
    });
    expect(auditEvents[0]).toMatchObject({
      context: {
        requestId: 'request-webhook',
        traceId: 'trace-webhook',
        principalId: 'principal-webhook',
        source: 'API',
      },
    });
    expect(JSON.stringify(auditEvents)).not.toContain('must-not-be-in-audit-context');
  });

  it('accepts the previous signing key only during rotation overlap', () => {
    const body = '{"id":"rotation"}';
    const signature = signWebhookBody(body, '1234567890123456');
    const secrets = {
      current: '6543210987654321',
      keyId: 'k2',
      previous: {
        secret: '1234567890123456',
        keyId: 'k1',
        expiresAt: new Date(Date.now() + 1_000),
      },
    };
    expect(verifyWebhookSignatureWithRotation(body, signature, secrets)).toBe('k1');
    expect(
      verifyWebhookSignatureWithRotation(body, signature, {
        ...secrets,
        previous: { ...secrets.previous, expiresAt: new Date(Date.now() - 1) },
      }),
    ).toBeUndefined();
  });
});

function encryptLegacyWebhookSecret(secret: string, masterKey: string): string {
  const key = createHash('sha256').update(masterKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}
