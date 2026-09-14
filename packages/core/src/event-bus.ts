export interface DomainEvent<TPayload = Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly organizationId: string;
  readonly timestamp: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly idempotencyKey: string;
  readonly payload: TPayload;
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
  ): Promise<RedisStreamRecord[]>;
  acknowledge(stream: string, group: string, id: string): Promise<void>;
  deadLetter(stream: string, record: RedisStreamRecord, error: unknown): Promise<void>;
}

export interface RedisStreamsEventBusOptions {
  readonly streamPrefix?: string;
  readonly consumerGroup?: string;
  readonly consumerName?: string;
  readonly batchSize?: number;
  readonly maxDeliveries?: number;
}

/**
 * At-least-once EventBus implementation backed by Redis Streams.  Publishing
 * is durable before returning; consumers acknowledge only after handlers have
 * completed, allowing Redis consumer-group redelivery after crashes.
 */
export class RedisStreamsEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<DomainEventHandler>>();
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
    };
    if (this.options.batchSize < 1 || this.options.maxDeliveries < 1)
      throw new Error('Redis stream limits must be positive');
  }
  async publish(event: DomainEvent): Promise<void> {
    await this.transport.append(this.stream(event.type), event);
  }
  subscribe(eventType: string, handler: DomainEventHandler): () => void {
    const handlers = this.handlers.get(eventType) ?? new Set<DomainEventHandler>();
    handlers.add(handler);
    this.handlers.set(eventType, handlers);
    return () => handlers.delete(handler);
  }
  /** Drain one batch for an event type; unacknowledged records are redelivered. */
  async consumeOnce(eventType: string): Promise<number> {
    const stream = this.stream(eventType);
    const records = await this.transport.readGroup(
      stream,
      this.options.consumerGroup,
      this.options.consumerName,
      this.options.batchSize,
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
        if (record.deliveries >= this.options.maxDeliveries)
          await this.transport.deadLetter(stream, record, error);
      }
    }
    return acknowledged;
  }
  private stream(eventType: string): string {
    return `${this.options.streamPrefix}:${eventType}`;
  }
}
