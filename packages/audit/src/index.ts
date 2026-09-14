import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  repositoryName,
  type Repository,
  type RepositoryName,
  type TenantEntity,
} from '@handstack/domain';
import { ValidationError } from '@handstack/shared';

export type AuditActorType = 'USER' | 'SERVICE' | 'SYSTEM';
export interface AuditEvent {
  readonly id: string;
  readonly timestamp: Date;
  readonly organizationId: string;
  readonly actorId: string;
  readonly actorType: AuditActorType;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly decision: 'ALLOW' | 'DENY';
  readonly ip?: string;
  readonly userAgent?: string;
  readonly traceId?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}
export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
  query(organizationId: string, action?: string): Promise<readonly AuditEvent[]>;
}

export interface AuditReceipt {
  readonly eventId: string;
  readonly sequence: number;
  readonly hash: string;
}

export interface AuditRange {
  readonly organizationId: string;
  readonly from?: Date;
  readonly to?: Date;
}

export interface AuditVerificationResult {
  readonly valid: boolean;
  readonly checked: number;
  readonly errors: readonly string[];
}

export interface AuditCheckpoint {
  readonly organizationId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly headHash: string;
  readonly createdAt: string;
  readonly signature: string;
}

export interface AuditSinkProvider {
  append(event: AuditEvent): Promise<AuditReceipt>;
  verify(range: AuditRange): Promise<AuditVerificationResult>;
  checkpoint(organizationId: string, signingKey: string): Promise<AuditCheckpoint>;
}
export interface SiemExporter {
  export(events: readonly AuditEvent[]): Promise<void>;
}

interface AuditEntity extends TenantEntity {
  readonly organizationId: string;
  readonly event: AuditEvent;
}

/** Append-only repository-backed audit sink. Querying walks all pages so the
 * API never silently truncates an organization's audit history at 200 rows. */
export class RepositoryAuditSink implements AuditSink {
  private readonly repository: Repository<AuditEntity>;

  constructor(repositoryFactory: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.repository = repositoryFactory<AuditEntity>(repositoryName('audit-events'));
  }

  async append(event: AuditEvent): Promise<void> {
    validateEvent(event);
    const timestamp = new Date(event.timestamp);
    await this.repository.insert({
      id: event.id,
      tenantId: event.organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      organizationId: event.organizationId,
      event: {
        ...event,
        timestamp,
        ...(event.metadata === undefined ? {} : { metadata: { ...event.metadata } }),
      },
    });
  }

  async query(organizationId: string, action?: string): Promise<readonly AuditEvent[]> {
    if (organizationId === '') throw new ValidationError('Audit organization is required');
    const events: AuditEvent[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.repository.list(organizationId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const entity of page.items) {
        const event = normalizeEvent(entity.event);
        if (action === undefined || event.action === action) events.push(event);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return events;
  }
}

/** Hash-chain adapter. Reserved metadata keys are persisted with the event so
 * the chain survives process restarts and works with every repository adapter. */
export class TamperEvidentAuditSink implements AuditSinkProvider {
  constructor(private readonly sink: AuditSink) {}

  async append(event: AuditEvent): Promise<AuditReceipt> {
    validateEvent(event);
    const prior = await this.sink.query(event.organizationId);
    const sequence = prior.length;
    const previousHash = prior.at(-1)?.metadata?.__auditHash ?? 'GENESIS';
    const hash = hashEvent(event, sequence, previousHash);
    await this.sink.append({
      ...event,
      metadata: {
        ...(event.metadata ?? {}),
        __auditSequence: String(sequence),
        __auditPreviousHash: previousHash,
        __auditHash: hash,
      },
    });
    return { eventId: event.id, sequence, hash };
  }

  async verify(range: AuditRange): Promise<AuditVerificationResult> {
    const events = (await this.sink.query(range.organizationId)).filter((event) => {
      const time = event.timestamp.getTime();
      return (
        (range.from === undefined || time >= range.from.getTime()) &&
        (range.to === undefined || time <= range.to.getTime())
      );
    });
    const errors: string[] = [];
    let previousHash = 'GENESIS';
    events.forEach((event, index) => {
      const metadata = event.metadata ?? {};
      const expected = hashEvent(event, Number(metadata.__auditSequence ?? index), previousHash);
      if (metadata.__auditPreviousHash !== previousHash)
        errors.push(`${event.id}: previous hash mismatch`);
      if (metadata.__auditHash !== expected) errors.push(`${event.id}: hash mismatch`);
      previousHash = metadata.__auditHash ?? expected;
    });
    return { valid: errors.length === 0, checked: events.length, errors };
  }

  async checkpoint(organizationId: string, signingKey: string): Promise<AuditCheckpoint> {
    const events = await this.sink.query(organizationId);
    const last = events.at(-1);
    if (last === undefined) throw new ValidationError('Cannot checkpoint an empty audit stream');
    const checkpoint = {
      organizationId,
      sequence: Number(last.metadata?.__auditSequence ?? events.length - 1),
      eventId: last.id,
      headHash: last.metadata?.__auditHash ?? '',
      createdAt: new Date().toISOString(),
    };
    return {
      ...checkpoint,
      signature: createHmac('sha256', signingKey).update(JSON.stringify(checkpoint)).digest('hex'),
    };
  }
}

function hashEvent(event: AuditEvent, sequence: number, previousHash: string): string {
  const metadata = Object.fromEntries(
    Object.entries(event.metadata ?? {}).filter(([key]) => !key.startsWith('__audit')),
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        sequence,
        previousHash,
        id: event.id,
        timestamp: new Date(event.timestamp).toISOString(),
        organizationId: event.organizationId,
        actorId: event.actorId,
        actorType: event.actorType,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        decision: event.decision,
        metadata,
      }),
    )
    .digest('hex');
}

function validateEvent(event: AuditEvent): void {
  if (event.organizationId === '' || event.id === '' || event.action === '')
    throw new ValidationError('Audit event identity is required');
}

function normalizeEvent(event: AuditEvent): AuditEvent {
  return {
    ...event,
    timestamp: new Date(event.timestamp),
    ...(event.metadata === undefined ? {} : { metadata: { ...event.metadata } }),
  };
}

/**
 * Structural webhook event accepted by the audit bridge.  Keeping this
 * contract structural avoids coupling the audit package to the webhook
 * dispatcher while still providing a concrete integration point.
 */
export interface WebhookAuditRecord {
  readonly type:
    'webhook.attempt' | 'webhook.delivered' | 'webhook.failed' | 'webhook.dead_lettered';
  readonly organizationId: string;
  readonly deliveryId: string;
  readonly event: string;
  readonly attempt: number;
  readonly error?: string;
}

/** Maps webhook lifecycle events to append-only audit events without storing
 * payloads or credentials.  Dispatchers may pass this directly as their
 * WebhookAuditSink because the method signatures are compatible. */
export class WebhookAuditBridge {
  constructor(
    private readonly sink: AuditSink,
    private readonly actorId = 'webhook-dispatcher',
  ) {}

  async record(input: WebhookAuditRecord): Promise<void> {
    const denied = input.type === 'webhook.failed' || input.type === 'webhook.dead_lettered';
    await this.sink.append({
      id: randomUUID(),
      timestamp: new Date(),
      organizationId: input.organizationId,
      actorId: this.actorId,
      actorType: 'SYSTEM',
      action: input.type.replace('webhook.', 'WEBHOOK_').toUpperCase(),
      resourceType: 'webhook_delivery',
      resourceId: input.deliveryId,
      decision: denied ? 'DENY' : 'ALLOW',
      metadata: {
        event: input.event,
        attempt: String(input.attempt),
        ...(input.error === undefined ? {} : { error: input.error }),
      },
    });
  }
}

export class InMemoryAuditSink implements AuditSink {
  private readonly events: AuditEvent[] = [];
  append(event: AuditEvent): Promise<void> {
    if (event.organizationId === '' || event.id === '' || event.action === '')
      return Promise.reject(new ValidationError('Audit event identity is required'));
    this.events.push(
      event.metadata === undefined ? { ...event } : { ...event, metadata: { ...event.metadata } },
    );
    return Promise.resolve();
  }
  query(organizationId: string, action?: string): Promise<readonly AuditEvent[]> {
    if (organizationId === '')
      return Promise.reject(new ValidationError('Audit organization is required'));
    return Promise.resolve(
      this.events
        .filter(
          (event) =>
            event.organizationId === organizationId &&
            (action === undefined || event.action === action),
        )
        .map((event) => ({ ...event })),
    );
  }
}

export class RedactingSiemExporter implements SiemExporter {
  constructor(
    private readonly send: (payload: readonly AuditEvent[]) => Promise<void>,
    private readonly redactKeys: readonly string[] = ['prompt', 'response', 'token', 'secret'],
  ) {}
  export(events: readonly AuditEvent[]): Promise<void> {
    const sanitized = events.map((event) =>
      event.metadata === undefined
        ? { ...event }
        : {
            ...event,
            metadata: Object.fromEntries(
              Object.entries(event.metadata).map(([key, value]) => [
                key,
                this.redactKeys.includes(key.toLowerCase()) ? '[REDACTED]' : value,
              ]),
            ),
          },
    );
    return this.send(sanitized);
  }
}
