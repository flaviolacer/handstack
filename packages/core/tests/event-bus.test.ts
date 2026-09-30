import { describe, expect, it, vi } from 'vitest';
import {
  InProcessEventBus,
  RedisStreamsEventBus,
  RedisStreamsTransportAdapter,
  isDomainEventContext,
  type DomainEvent,
  type RedisStreamRecord,
  type RedisStreamsTransport,
} from '../src/index.js';

describe('InProcessEventBus', () => {
  it('publishes to subscribers and supports unsubscribe', async () => {
    const bus = new InProcessEventBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('example.created', handler);
    const event: DomainEvent = {
      id: 'event-1',
      type: 'example.created',
      schemaVersion: 1,
      organizationId: 'org-1',
      timestamp: '2026-08-31T00:00:00.000Z',
      correlationId: 'correlation-1',
      idempotencyKey: 'idem-1',
      payload: {},
    };

    await bus.publish(event);
    unsubscribe();
    await bus.publish(event);

    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('RedisStreamsEventBus', () => {
  it('publishes durable records and acknowledges only successful handlers', async () => {
    const records: RedisStreamRecord[] = [];
    const acknowledged: string[] = [];
    const dead: string[] = [];
    const transport: RedisStreamsTransport = {
      append: (stream, event) =>
        Promise.resolve().then(() => {
          records.push({ id: `${stream}-1`, event, deliveries: 1 });
          return `${stream}-1`;
        }),
      readGroup: () => Promise.resolve().then(() => records.splice(0)),
      acknowledge: (_stream, _group, id) =>
        Promise.resolve().then(() => {
          acknowledged.push(id);
        }),
      deadLetter: (_stream, record) =>
        Promise.resolve().then(() => {
          dead.push(record.id);
        }),
    };
    const bus = new RedisStreamsEventBus(transport, { consumerName: 'test' });
    const handler = vi.fn();
    bus.subscribe('example.created', handler);
    await bus.publish({ ...eventFixture, type: 'example.created' });
    await expect(bus.consumeOnce('example.created')).resolves.toBe(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(acknowledged).toHaveLength(1);
    expect(dead).toHaveLength(0);
  });

  it('starts and stops a background consumer for distributed subscriptions', async () => {
    const records: RedisStreamRecord[] = [];
    const acknowledged: string[] = [];
    const transport: RedisStreamsTransport = {
      append: (stream, event) => {
        records.push({ id: `${stream}-1`, event, deliveries: 1 });
        return Promise.resolve(`${stream}-1`);
      },
      readGroup: () => Promise.resolve(records.splice(0)),
      acknowledge: (_stream, _group, id) => {
        acknowledged.push(id);
        return Promise.resolve();
      },
      deadLetter: () => Promise.resolve(),
    };
    const bus = new RedisStreamsEventBus(transport, {
      consumerName: 'background-test',
      pollIntervalMs: 10,
    });
    const handler = vi.fn(() => Promise.resolve());
    const unsubscribe = bus.subscribe('example.created', handler);
    await bus.publish({ ...eventFixture, type: 'example.created' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(handler).toHaveBeenCalledOnce();
    expect(acknowledged).toHaveLength(1);
    unsubscribe();
    bus.close();
  });
});

describe('RedisStreamsTransportAdapter', () => {
  it('creates a group, round-trips events and sends poison records to a DLQ', async () => {
    const entries: RedisStreamRecord[] = [];
    const groups: string[] = [];
    const acks: string[] = [];
    const dlq: { stream: string; fields: Record<string, string> }[] = [];
    const client = {
      xadd: (stream: string, _id: '*', fields: Record<string, string>) => {
        if (stream.endsWith(':dead-letter')) dlq.push({ stream, fields });
        else {
          const encoded = fields.event;
          if (encoded === undefined) throw new Error('event field missing');
          entries.push({ id: '1-0', event: JSON.parse(encoded) as DomainEvent, deliveries: 3 });
        }
        return Promise.resolve('1-0');
      },
      xgroupCreate: (stream: string, group: string) => {
        groups.push(`${stream}:${group}`);
        return Promise.resolve();
      },
      xreadgroup: () =>
        Promise.resolve(
          entries.map((record) => ({
            id: record.id,
            fields: { event: JSON.stringify(record.event) },
            deliveries: record.deliveries,
          })),
        ),
      xautoclaim: () => Promise.resolve({ nextStartId: '0-0', entries: [] }),
      xack: (_stream: string, _group: string, id: string) => {
        acks.push(id);
        return Promise.resolve();
      },
    };
    const transport = new RedisStreamsTransportAdapter(client);
    await transport.append('handstack:events:example', eventFixture);
    const records = await transport.readGroup(
      'handstack:events:example',
      'workers',
      'consumer',
      10,
    );
    expect(records[0]?.event).toEqual(eventFixture);
    await transport.acknowledge('handstack:events:example', 'workers', '1-0');
    const record = records[0];
    if (record === undefined) throw new Error('record missing');
    await transport.deadLetter('handstack:events:example', record, new Error('poison'));
    expect(groups).toEqual(['handstack:events:example:workers']);
    expect(acks).toEqual(['1-0']);
    expect(dlq[0]?.fields).toMatchObject({ sourceId: '1-0', error: 'poison', deliveries: '3' });
  });

  it('dead-letters and acknowledges poison records after the delivery limit', async () => {
    let pending: RedisStreamRecord | undefined = {
      id: 'poison-1',
      event: { ...eventFixture, type: 'example.poison' },
      deliveries: 3,
    };
    const deadLetter = vi.fn(() => Promise.resolve());
    const acknowledge = vi.fn(() => {
      pending = undefined;
      return Promise.resolve();
    });
    const transport: RedisStreamsTransport = {
      append: () => Promise.resolve('unused'),
      readGroup: () => Promise.resolve(pending === undefined ? [] : [pending]),
      acknowledge,
      deadLetter,
    };
    const bus = new RedisStreamsEventBus(transport, {
      consumerName: 'poison-test',
      maxDeliveries: 3,
    });
    bus.subscribe('example.poison', () => Promise.reject(new Error('poison')));

    await expect(bus.consumeOnce('example.poison')).resolves.toBe(1);
    await expect(bus.consumeOnce('example.poison')).resolves.toBe(0);
    expect(deadLetter).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledOnce();
    bus.close();
  });

  it('rejects serialized event context that attempts to carry stale permissions', async () => {
    const eventWithAuthority = {
      ...eventFixture,
      context: {
        requestId: 'request-1',
        traceId: 'trace-1',
        principalId: 'principal-1',
        source: 'API',
        permissions: ['admin'],
      },
    };
    const transport = new RedisStreamsTransportAdapter({
      xadd: () => Promise.resolve('1-0'),
      xgroupCreate: () => Promise.resolve(),
      xautoclaim: () => Promise.resolve({ nextStartId: '0-0', entries: [] }),
      xreadgroup: () =>
        Promise.resolve([
          {
            id: '1-0',
            fields: { event: JSON.stringify(eventWithAuthority) },
            deliveries: 1,
          },
        ]),
      xack: () => Promise.resolve(),
    });

    await expect(transport.readGroup('stream', 'group', 'consumer', 1)).rejects.toThrow(
      'Redis stream event payload is invalid',
    );
  });

  it('bounds the identifiers in execution provenance before it can cross a queue boundary', () => {
    expect(
      isDomainEventContext({
        requestId: 'r'.repeat(129),
        traceId: 'trace-1',
        principalId: 'principal-1',
        source: 'API',
      }),
    ).toBe(false);
    expect(
      isDomainEventContext({
        requestId: 'request-1',
        traceId: 'trace-1',
        principalId: 'principal-1',
        source: 'API',
      }),
    ).toBe(true);
  });
});

const eventFixture: DomainEvent = {
  id: 'event-1',
  type: 'example',
  schemaVersion: 1,
  organizationId: 'org-1',
  timestamp: '2026-08-31T00:00:00.000Z',
  correlationId: 'correlation-1',
  idempotencyKey: 'idem-1',
  payload: {},
};
