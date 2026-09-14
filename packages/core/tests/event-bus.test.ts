import { describe, expect, it, vi } from 'vitest';
import {
  InProcessEventBus,
  RedisStreamsEventBus,
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
