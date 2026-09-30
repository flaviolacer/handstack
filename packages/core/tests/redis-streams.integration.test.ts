import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RedisStreamsTransportAdapter,
  type DomainEvent,
  type RedisStreamsClient,
} from '../src/index.js';

const configuredUrl = process.env.HANDSTACK_TEST_REDIS_URL?.trim();

describe.skipIf(configuredUrl === undefined || configuredUrl === '')(
  'Redis Streams transport integration',
  () => {
    const stream = `handstack:conformance:${String(Date.now())}`;
    const client = createClient({ url: configuredUrl ?? '' });
    let transport: RedisStreamsTransportAdapter;

    beforeAll(async () => {
      await client.connect();
      transport = new RedisStreamsTransportAdapter(redisClient(client));
    });

    afterAll(async () => {
      await client.del(`${stream}:dead-letter`);
      await client.del(stream);
      await client.quit();
    });

    it('publishes, consumes, acknowledges and dead-letters through real Redis', async () => {
      const event: DomainEvent = {
        id: 'redis-event-1',
        type: 'conformance.event',
        schemaVersion: 1,
        organizationId: 'redis-org',
        timestamp: new Date().toISOString(),
        correlationId: 'redis-correlation',
        idempotencyKey: 'redis-idempotency',
        payload: { ok: true },
      };
      const id = await transport.append(stream, event);
      const records = await transport.readGroup(stream, 'conformance-workers', 'consumer-a', 10);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ id, event });
      await transport.acknowledge(stream, 'conformance-workers', id);
      await transport.deadLetter(stream, { id, event, deliveries: 5 }, new Error('poison'));
      expect(await client.xLen(`${stream}:dead-letter`)).toBe(1);

      const pendingEvent = { ...event, id: 'redis-pending-event', idempotencyKey: 'pending-idem' };
      const pendingId = await transport.append(stream, pendingEvent);
      const firstDelivery = await transport.readGroup(
        stream,
        'conformance-workers',
        'consumer-a',
        10,
      );
      expect(firstDelivery.map((record) => record.id)).toContain(pendingId);
      const reclaimed = await transport.readGroup(
        stream,
        'conformance-workers',
        'consumer-b',
        10,
        0,
      );
      expect(reclaimed).toContainEqual({ id: pendingId, event: pendingEvent, deliveries: 2 });
      const reclaimedRecord = reclaimed[0];
      if (reclaimedRecord === undefined) throw new Error('pending record was not reclaimed');
      await transport.deadLetter(stream, reclaimedRecord, new Error('poison after retry'));
      await transport.acknowledge(stream, 'conformance-workers', pendingId);
      expect(await transport.readGroup(stream, 'conformance-workers', 'consumer-c', 10, 0)).toEqual(
        [],
      );
      expect(await client.xLen(`${stream}:dead-letter`)).toBe(2);
    });
  },
);

function redisClient(client: ReturnType<typeof createClient>): RedisStreamsClient {
  return {
    xadd: (stream, _id, fields) => client.xAdd(stream, '*', fields),
    xgroupCreate: async (stream, group, id, createStream) => {
      await client.xGroupCreate(stream, group, id, { MKSTREAM: createStream });
    },
    xreadgroup: async (group, consumer, stream, count) => {
      const raw: unknown = await client.xReadGroup(
        group,
        consumer,
        { key: stream, id: '>' },
        { COUNT: count },
      );
      const result = Array.isArray(raw) ? (raw as readonly RedisBatch[]) : [];
      return result.flatMap((batch) =>
        batch.messages.map((message) => ({
          id: message.id,
          fields: message.message,
          deliveries: 1,
        })),
      );
    },
    xautoclaim: async (stream, group, consumer, minIdleMs, startId, count) => {
      const raw: unknown = await client.sendCommand([
        'XAUTOCLAIM',
        stream,
        group,
        consumer,
        String(minIdleMs),
        startId,
        'COUNT',
        String(count),
      ]);
      const response = Array.isArray(raw) ? raw : [];
      const nextStartId = typeof response[0] === 'string' ? response[0] : '0-0';
      const messages = Array.isArray(response[1]) ? response[1] : [];
      const entries = [];
      for (const message of messages) {
        if (!Array.isArray(message) || typeof message[0] !== 'string' || !Array.isArray(message[1]))
          continue;
        const id = message[0];
        const fields = new Map<string, string>();
        const flatFields = message[1] as unknown[];
        for (let index = 0; index + 1 < flatFields.length; index += 2) {
          const key = flatFields[index];
          const value = flatFields[index + 1];
          if (typeof key === 'string' && typeof value === 'string') fields.set(key, value);
        }
        const pending: unknown = await client.sendCommand(['XPENDING', stream, group, id, id, '1']);
        const pendingRows: unknown[] = Array.isArray(pending) ? (pending as unknown[]) : [];
        const firstPending = pendingRows[0] as unknown[] | undefined;
        const deliveryCount = Number(firstPending?.[3] ?? 1);
        entries.push({
          id,
          fields: Object.fromEntries(fields),
          deliveries: Number.isInteger(deliveryCount) ? deliveryCount : 1,
        });
      }
      return { nextStartId, entries };
    },
    xack: async (stream, group, id) => {
      await client.xAck(stream, group, id);
    },
  };
}

interface RedisBatch {
  readonly messages: readonly {
    readonly id: string;
    readonly message: Readonly<Record<string, string>>;
  }[];
}
