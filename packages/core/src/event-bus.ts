import type { ExecutionSource } from './execution-context.js';

export interface DomainEvent<TPayload = Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly organizationId: string;
  readonly timestamp: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly idempotencyKey: string;
  /** Non-authoritative audit provenance; permissions are deliberately not serialized. */
  readonly context?: DomainEventContext;
  readonly payload: TPayload;
}

export interface DomainEventContext {
  readonly requestId: string;
  readonly traceId: string;
  readonly principalId: string;
  readonly source: ExecutionSource;
}

export type DomainEventHandler<TEvent extends DomainEvent = DomainEvent> = (
  event: TEvent,
) => Promise<void>;

export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(eventType: string, handler: DomainEventHandler): () => void;
}

export class InProcessEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<DomainEventHandler>>();

  async publish(event: DomainEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? new Set<DomainEventHandler>();
    await Promise.all([...handlers].map(async (handler) => handler(event)));
  }

  subscribe(eventType: string, handler: DomainEventHandler): () => void {
    const handlers = this.handlers.get(eventType) ?? new Set<DomainEventHandler>();
    handlers.add(handler);
    this.handlers.set(eventType, handlers);
    return () => handlers.delete(handler);
  }
}

/** A Redis Streams record supplied by a transport adapter. */
export interface RedisStreamRecord {
  readonly id: string;
  readonly event: DomainEvent;
  readonly deliveries: number;
}

/**
 * Transport boundary for the distributed event bus.  Implementations normally
 * call Redis XADD/XREADGROUP/XACK and route poison messages to a dead-letter
 * stream.  Keeping Redis out of core makes local development deterministic.
 */
export interface RedisStreamsTransport {
  append(stream: string, event: DomainEvent): Promise<string>;
  readGroup(
    stream: string,
    group: string,
    consumer: string,
    count: number,
    minIdleMs?: number,
  ): Promise<RedisStreamRecord[]>;
  acknowledge(stream: string, group: string, id: string): Promise<void>;
  deadLetter(stream: string, record: RedisStreamRecord, error: unknown): Promise<void>;
}

/** Minimal Redis Streams client surface; applications can bind node-redis or ioredis. */
export interface RedisStreamsClient {
  xadd(stream: string, id: '*', fields: Readonly<Record<string, string>>): Promise<string>;
  xgroupCreate(stream: string, group: string, id: '0' | '$', createStream: boolean): Promise<void>;
  xreadgroup(
    group: string,
    consumer: string,
    stream: string,
    count: number,
  ): Promise<readonly RedisStreamsClientEntry[]>;
  xautoclaim(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    startId: string,
    count: number,
  ): Promise<RedisStreamsAutoClaimResult>;
  xack(stream: string, group: string, id: string): Promise<void>;
}

export interface RedisStreamsClientEntry {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly deliveries: number;
}

export interface RedisStreamsAutoClaimResult {
  readonly nextStartId: string;
  readonly entries: readonly RedisStreamsClientEntry[];
}

/** Concrete Redis Streams transport with explicit ACK and poison-event routing. */
export class RedisStreamsTransportAdapter implements RedisStreamsTransport {
  private readonly groups = new Set<string>();
  private readonly claimCursors = new Map<string, string>();

  constructor(
    private readonly client: RedisStreamsClient,
    private readonly deadLetterSuffix = ':dead-letter',
  ) {
    if (deadLetterSuffix.trim() === '') throw new Error('Redis dead-letter suffix is required');
  }

  async append(stream: string, event: DomainEvent): Promise<string> {
    return this.client.xadd(stream, '*', { event: JSON.stringify(event) });
  }

  async readGroup(
    stream: string,
    group: string,
    consumer: string,
    count: number,
    minIdleMs = 30_000,
  ): Promise<RedisStreamRecord[]> {
    if (count < 1) throw new Error('Redis stream read count must be positive');
    if (!Number.isInteger(minIdleMs) || minIdleMs < 0)
      throw new Error('Redis pending idle time must be a non-negative integer');
    const groupKey = `${stream}\u0000${group}`;
    if (!this.groups.has(groupKey)) {
      try {
        await this.client.xgroupCreate(stream, group, '0', true);
      } catch (error) {
        // Concurrent replicas may create the same group. BUSYGROUP is safe to ignore.
        if (!String(error).includes('BUSYGROUP')) throw error;
      }
      this.groups.add(groupKey);
    }
    const claimKey = `${stream}\u0000${group}\u0000${consumer}`;
    const claimed = await this.client.xautoclaim(
      stream,
      group,
      consumer,
      minIdleMs,
      this.claimCursors.get(claimKey) ?? '0-0',
      count,
    );
    // Continue scanning the PEL over subsequent polls so entries past the
    // first COUNT range are eventually eligible for recovery.
    this.claimCursors.set(claimKey, claimed.nextStartId);
    const fresh =
      claimed.entries.length >= count
        ? []
        : await this.client.xreadgroup(group, consumer, stream, count - claimed.entries.length);
    const entries = [...claimed.entries, ...fresh];
    return entries.map((entry) => {
      const encoded = entry.fields.event;
      if (encoded === undefined) throw new Error('Redis stream entry has no event field');
      let event: DomainEvent;
      try {
        event = JSON.parse(encoded) as DomainEvent;
      } catch {
        throw new Error('Redis stream event payload is invalid JSON');
      }
      if (!isDomainEvent(event)) throw new Error('Redis stream event payload is invalid');
      return { id: entry.id, event, deliveries: entry.deliveries };
    });
  }

  acknowledge(stream: string, group: string, id: string): Promise<void> {
    return this.client.xack(stream, group, id);
  }

  async deadLetter(stream: string, record: RedisStreamRecord, error: unknown): Promise<void> {
    await this.client.xadd(`${stream}${this.deadLetterSuffix}`, '*', {
      event: JSON.stringify(record.event),
      sourceId: record.id,
      error: error instanceof Error ? error.message : String(error),
      deliveries: String(record.deliveries),
    });
  }
}

function isDomainEvent(value: unknown): value is DomainEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const requiredStrings = [
    'id',
    'type',
    'organizationId',
    'timestamp',
    'correlationId',
    'idempotencyKey',
  ].every((key) => {
    const field = candidate[key];
    return typeof field === 'string' && field.trim() !== '';
  });
  const schemaVersion = candidate.schemaVersion;
  const contextValid = candidate.context === undefined || isDomainEventContext(candidate.context);
  return (
    requiredStrings &&
    typeof schemaVersion === 'number' &&
    Number.isInteger(schemaVersion) &&
    schemaVersion >= 1 &&
    contextValid &&
    Object.prototype.hasOwnProperty.call(candidate, 'payload')
  );
}

export function isDomainEventContext(value: unknown): value is DomainEventContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  const allowedKeys = ['requestId', 'traceId', 'principalId', 'source'];
  return (
    Object.keys(context).every((key) => allowedKeys.includes(key)) &&
    ['requestId', 'traceId', 'principalId'].every((key) => {
      const field = context[key];
      return typeof field === 'string' && field.trim() !== '' && field.length <= 128;
    }) &&
    ['WEB', 'API', 'MCP', 'AGENT', 'SYSTEM'].includes(String(context.source))
  );
}

export interface RedisStreamsEventBusOptions {
  readonly streamPrefix?: string;
  readonly consumerGroup?: string;
  readonly consumerName?: string;
  readonly batchSize?: number;
  readonly maxDeliveries?: number;
  readonly pollIntervalMs?: number;
  readonly pendingClaimIdleMs?: number;
}

/**
 * At-least-once EventBus implementation backed by Redis Streams.  Publishing
 * is durable before returning; consumers acknowledge only after handlers have
 * completed, allowing Redis consumer-group redelivery after crashes.
 */
export class RedisStreamsEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<DomainEventHandler>>();
  private readonly pollers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly polling = new Set<string>();
  private readonly options: Required<RedisStreamsEventBusOptions>;
  constructor(
    private readonly transport: RedisStreamsTransport,
    options: RedisStreamsEventBusOptions = {},
  ) {
    this.options = {
      streamPrefix: options.streamPrefix ?? 'handstack:events',
      consumerGroup: options.consumerGroup ?? 'handstack-workers',
      consumerName: options.consumerName ?? `consumer-${Math.random().toString(36).slice(2)}`,
      batchSize: options.batchSize ?? 100,
      maxDeliveries: options.maxDeliveries ?? 5,
      pollIntervalMs: options.pollIntervalMs ?? 250,
      pendingClaimIdleMs: options.pendingClaimIdleMs ?? 30_000,
    };
    if (
      this.options.batchSize < 1 ||
      this.options.maxDeliveries < 1 ||
      this.options.pollIntervalMs < 10 ||
      !Number.isInteger(this.options.pendingClaimIdleMs) ||
      this.options.pendingClaimIdleMs < 0
    )
      throw new Error('Redis stream limits must be positive');
  }
  async publish(event: DomainEvent): Promise<void> {
    await this.transport.append(this.stream(event.type), event);
  }
  subscribe(eventType: string, handler: DomainEventHandler): () => void {
    const handlers = this.handlers.get(eventType) ?? new Set<DomainEventHandler>();
    handlers.add(handler);
    this.handlers.set(eventType, handlers);
    this.startPolling(eventType);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.stopPolling(eventType);
    };
  }
  /** Drain one batch for an event type; unacknowledged records are redelivered. */
  async consumeOnce(eventType: string): Promise<number> {
    const stream = this.stream(eventType);
    const records = await this.transport.readGroup(
      stream,
      this.options.consumerGroup,
      this.options.consumerName,
      this.options.batchSize,
      this.options.pendingClaimIdleMs,
    );
    const handlers = this.handlers.get(eventType) ?? new Set<DomainEventHandler>();
    let acknowledged = 0;
    for (const record of records) {
      try {
        await Promise.all([...handlers].map((handler) => handler(record.event)));
        await this.transport.acknowledge(stream, this.options.consumerGroup, record.id);
        acknowledged += 1;
      } catch (error) {
        // Leave transient failures pending for consumer-group redelivery. The
        // transport moves poison records to DLQ once the delivery threshold is hit.
        if (record.deliveries >= this.options.maxDeliveries) {
          await this.transport.deadLetter(stream, record, error);
          await this.transport.acknowledge(stream, this.options.consumerGroup, record.id);
          acknowledged += 1;
        }
      }
    }
    return acknowledged;
  }
  /** Stop background consumers before the Redis client is closed. */
  close(): void {
    for (const eventType of this.pollers.keys()) this.stopPolling(eventType);
  }
  private startPolling(eventType: string): void {
    if (this.pollers.has(eventType)) return;
    const timer = setInterval(() => {
      if (this.polling.has(eventType)) return;
      this.polling.add(eventType);
      void this.consumeOnce(eventType)
        .catch(() => undefined)
        .finally(() => this.polling.delete(eventType));
    }, this.options.pollIntervalMs);
    timer.unref();
    this.pollers.set(eventType, timer);
  }
  private stopPolling(eventType: string): void {
    const timer = this.pollers.get(eventType);
    if (timer === undefined) return;
    clearInterval(timer);
    this.pollers.delete(eventType);
    this.polling.delete(eventType);
  }
  private stream(eventType: string): string {
    return `${this.options.streamPrefix}:${eventType}`;
  }
}
