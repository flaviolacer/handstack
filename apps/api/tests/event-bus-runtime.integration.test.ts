import { defineConfig } from '@handstack/config';
import { RedisSubjectCache } from '@handstack/privacy';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBusRuntimeService } from '../src/core/event-bus-runtime.service.js';

const redisUrl = process.env.HANDSTACK_TEST_REDIS_URL?.trim();

describe.skipIf(redisUrl === undefined || redisUrl === '')(
  'API event bus runtime integration',
  () => {
    let runtime: EventBusRuntimeService;

    beforeAll(() => {
      const config = defineConfig({
        deployment: { profile: 'distributed' },
        database: { adapter: 'sqlite', url: 'file:./event-bus-runtime.test.db' },
        queue: { redisUrl, topology: 'standalone', pendingClaimIdleMs: 0 },
      });
      runtime = new EventBusRuntimeService({ config } as never);
    });

    afterAll(async () => {
      await runtime.onModuleDestroy();
    });

    it('routes a tenant-scoped event through the configured Redis Streams runtime', async () => {
      const received: unknown[] = [];
      const unsubscribe = runtime.subscribe('runtime.integration', (event) => {
        received.push(event);
        return Promise.resolve();
      });
      try {
        await runtime.publish({
          id: `runtime-event-${String(Date.now())}`,
          type: 'runtime.integration',
          schemaVersion: 1,
          organizationId: 'runtime-org',
          timestamp: new Date().toISOString(),
          correlationId: 'runtime-correlation',
          idempotencyKey: `runtime-idempotency-${String(Date.now())}`,
          payload: { source: 'api-runtime' },
        });
        await expect(runtime.consumeOnce('runtime.integration')).resolves.toBe(1);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          type: 'runtime.integration',
          organizationId: 'runtime-org',
          payload: { source: 'api-runtime' },
        });
      } finally {
        unsubscribe();
      }
    });

    it('recovers a pending event left by a crashed API consumer', async () => {
      const config = defineConfig({
        deployment: { profile: 'distributed' },
        queue: { redisUrl, topology: 'standalone', pendingClaimIdleMs: 0 },
      });
      const eventType = `runtime.recovery.${String(Date.now())}`;
      const stream = `${config.queue.namespaces.streams}:events:${eventType}`;
      const redis = new Redis(redisUrl ?? '');
      const event = {
        id: `abandoned-event-${String(Date.now())}`,
        type: eventType,
        schemaVersion: 1,
        organizationId: 'runtime-org',
        timestamp: new Date().toISOString(),
        correlationId: 'crashed-consumer-correlation',
        idempotencyKey: `abandoned-idem-${String(Date.now())}`,
        payload: { source: 'crashed-consumer' },
      };
      let unsubscribe: (() => void) | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await redis.xgroup('CREATE', stream, 'handstack-workers', '0', 'MKSTREAM');
        const eventId = await redis.xadd(stream, '*', 'event', JSON.stringify(event));
        await redis.call('XREADGROUP', [
          'GROUP',
          'handstack-workers',
          'crashed-consumer',
          'COUNT',
          1,
          'STREAMS',
          stream,
          '>',
        ]);
        const receivedPromise = new Promise<unknown>((resolve) => {
          unsubscribe = runtime.subscribe(eventType, (received) => {
            resolve(received);
            return Promise.resolve();
          });
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('pending event was not recovered'));
          }, 5_000);
        });
        const received = await Promise.race([receivedPromise, timeoutPromise]);
        expect(received).toEqual(event);
        expect(await redis.xpending(stream, 'handstack-workers', '-', '+', '10')).toHaveLength(0);
        expect(eventId).toMatch(/^\d+-\d+$/u);
      } finally {
        unsubscribe?.();
        if (timeout !== undefined) clearTimeout(timeout);
        await redis.del(stream);
        await redis.quit();
      }
    });

    it('exposes the shared Redis client for tenant-scoped privacy cache purges', async () => {
      const redisClient = runtime.subjectCache;
      if (redisClient === undefined) throw new Error('Expected distributed Redis client');
      const cache = new RedisSubjectCache(redisClient);
      const key = `runtime-cache-${String(Date.now())}`;
      await cache.set(key, 'runtime-org', 'secret-value', 'runtime-user');
      await expect(cache.get(key, 'runtime-org')).resolves.toBe('secret-value');
      await expect(
        cache.deleteSubject({
          organizationId: 'runtime-org',
          subjectId: 'runtime-user',
          requestId: 'runtime-cache-request',
        }),
      ).resolves.toMatchObject({
        destination: 'CACHE',
        deleted: true,
        evidence: ['redis-cache-entries-removed:1'],
      });
      await expect(cache.get(key, 'runtime-org')).resolves.toBeNull();
    });
  },
);
