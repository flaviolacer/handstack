import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { WebhookRuntimeService } from '../src/webhooks/webhook-runtime.service.js';
import { AuditRuntimeService } from '../src/audit/audit-runtime.service.js';
import { verifyWebhookSignature } from '@handstack/webhooks';
import { InProcessEventBus } from '@handstack/core';

describe('tenant webhook runtime boundary', () => {
  let database: DatabaseService | undefined;
  const originalMasterKey = process.env.HANDSTACK_MASTER_KEY;
  afterEach(async () => {
    vi.unstubAllGlobals();
    await database?.onModuleDestroy();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    if (originalMasterKey === undefined) delete process.env.HANDSTACK_MASTER_KEY;
    else process.env.HANDSTACK_MASTER_KEY = originalMasterKey;
  });

  it('audits secret access without secret material and rotates the dispatcher exactly once', async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_MASTER_KEY = 'c'.repeat(64);
    database = new DatabaseService();
    await database.onModuleInit();
    const audit = new AuditRuntimeService();
    const bus = new InProcessEventBus();
    const events: unknown[] = [];
    bus.subscribe('webhook.delivered', (event) => {
      events.push(event);
      return Promise.resolve();
    });
    const runtime = new WebhookRuntimeService(database, audit, { bus } as never);
    let sent: { body: string; signature: string } | undefined;
    const transport = {
      send: (input: { body: string; signature: string }) => {
        sent = input;
        return Promise.resolve();
      },
    };
    await runtime.configure(
      'org',
      'https://example.test/hook',
      'old-webhook-secret-long',
      undefined,
      transport,
    );
    const rotated = await runtime.rotateSecret('org', 'new-webhook-secret-long', 'key-new', 60_000);
    expect(rotated.keyId).toBe('key-new');
    expect(typeof rotated.previousKeyId).toBe('string');
    await runtime.dispatch({
      organizationId: 'org',
      id: 'd-rotation',
      event: 'user.created',
      payload: {},
      context: {
        requestId: 'req-webhook',
        traceId: 'trace-webhook',
        principalId: 'user-a',
        source: 'API',
      },
    });

    expect(events[0]).toMatchObject({
      type: 'webhook.delivered',
      context: { requestId: 'req-webhook', traceId: 'trace-webhook', principalId: 'user-a' },
    });

    const captured = sent;
    if (captured === undefined) throw new Error('Webhook transport was not called');
    expect(
      verifyWebhookSignature(captured.body, captured.signature, 'new-webhook-secret-long'),
    ).toBe(true);
    expect(
      verifyWebhookSignature(captured.body, captured.signature, 'old-webhook-secret-long'),
    ).toBe(false);
    const accesses = await audit.query('org', 'SECRET_ACCESSED');
    expect(accesses).toHaveLength(1);
    expect(accesses[0]?.actorType).toBe('SYSTEM');
    expect(accesses[0]?.resourceType).toBe('secret');
    expect(accesses[0]?.metadata).toMatchObject({
      name: 'webhook signing secret',
      pluginId: 'webhook-signing',
      provider: 'repository',
    });
    expect(typeof accesses[0]?.metadata?.keyId).toBe('string');
    expect(JSON.stringify(accesses)).not.toContain('webhook-secret-long');
    expect(JSON.stringify(accesses)).not.toContain('ciphertext');
  });

  it('persists dead letters and replays them through the configured tenant endpoint', async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    database = new DatabaseService();
    await database.onModuleInit();
    let healthy = false;
    let sends = 0;
    const audit = new AuditRuntimeService();
    const runtime = new WebhookRuntimeService(database, audit);
    await runtime.configure('org', 'https://example.test/hook', '1234567890123456', undefined, {
      send: () => {
        sends += 1;
        return healthy ? Promise.resolve() : Promise.reject(new Error('offline'));
      },
    });
    await expect(
      runtime.dispatch({ organizationId: 'org', id: 'd1', event: 'user.created', payload: {} }),
    ).resolves.toMatchObject({ status: 'DEAD_LETTERED' });
    await expect(audit.query('org', 'WEBHOOK_DEAD_LETTERED')).resolves.toHaveLength(1);
    expect(await runtime.deadLetters('org')).toHaveLength(1);
    healthy = true;
    await expect(runtime.replay('org', 'd1')).resolves.toMatchObject({ status: 'DELIVERED' });
    expect(sends).toBe(4);
  });

  it('uses the configured HTTP timeout for webhook delivery', async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    database = new DatabaseService();
    await database.onModuleInit();
    database.config.timeouts.http = 5;
    const captured: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal instanceof AbortSignal) {
            captured.push(signal);
            signal.addEventListener(
              'abort',
              () => {
                reject(
                  signal.reason instanceof Error ? signal.reason : new Error('Request aborted'),
                );
              },
              { once: true },
            );
          }
        }),
    );
    const runtime = new WebhookRuntimeService(database);
    await runtime.configure('org', 'https://example.test/hook', '1234567890123456');
    await expect(
      runtime.dispatch({
        organizationId: 'org',
        id: 'timeout',
        event: 'user.created',
        payload: {},
      }),
    ).resolves.toMatchObject({ status: 'DEAD_LETTERED' });
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((signal) => signal.aborted)).toBe(true);
    vi.unstubAllGlobals();
  });
});
