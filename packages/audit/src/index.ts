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

export interface AuditExportManifest {
  readonly version: 1;
  readonly format: 'ndjson';
  readonly organizationId: string;
  readonly eventCount: number;
  readonly firstEventId?: string;
  readonly lastEventId?: string;
  readonly headHash?: string;
  readonly contentSha256: string;
  readonly generatedAt: string;
}

export interface AuditExportVerificationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface AuditSinkProvider {
  append(event: AuditEvent): Promise<AuditReceipt>;
  verify(range: AuditRange): Promise<AuditVerificationResult>;
  checkpoint(organizationId: string, signingKey: string): Promise<AuditCheckpoint>;
}

/** Minimal Redis command surface used to coordinate audit heads across replicas. */
export interface AuditLockClient {
  set(key: string, value: string, ...options: readonly string[]): Promise<string | null>;
  eval(script: string, numberOfKeys: number, ...arguments_: readonly string[]): Promise<unknown>;
}

export interface AuditAppendCoordinator {
  withOrganizationLock<T>(organizationId: string, operation: () => Promise<T>): Promise<T>;
}

/**
 * Redis-based fencing for the short read/hash/append critical section. The
 * token check on release prevents an expired owner from deleting a newer
 * owner's lock. A bounded wait makes an unavailable Redis deployment fail
 * closed instead of silently producing competing audit heads.
 */
export class RedisAuditAppendCoordinator implements AuditAppendCoordinator {
  private static readonly releaseScript =
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
  private static readonly renewScript =
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

  constructor(
    private readonly client: AuditLockClient,
    private readonly options: {
      readonly keyPrefix?: string;
      readonly leaseMs?: number;
      readonly waitMs?: number;
      readonly retryMs?: number;
    } = {},
  ) {}

  async withOrganizationLock<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    const normalized = organizationId.trim();
    if (normalized === '') throw new ValidationError('Audit organization is required');
    const leaseMs = this.options.leaseMs ?? 30_000;
    const waitMs = this.options.waitMs ?? 15_000;
    const retryMs = this.options.retryMs ?? 25;
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1_000 ||
      !Number.isSafeInteger(waitMs) ||
      waitMs < 0 ||
      !Number.isSafeInteger(retryMs) ||
      retryMs < 1
    )
      throw new ValidationError('Audit lock timing is invalid');
    const key = `${this.options.keyPrefix ?? 'handstack:audit-lock'}:${normalized}`;
    const token = randomUUID();
    const deadline = Date.now() + waitMs;
    let acquired = false;
    while (Date.now() <= deadline) {
      const result = await this.client.set(key, token, 'NX', 'PX', String(leaseMs));
      if (result === 'OK') {
        acquired = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
    if (!acquired) throw new Error('Audit append lock could not be acquired');
    const leaseState = { lost: false };
    const renewalIntervalMs = Math.max(250, Math.floor(leaseMs / 3));
    const renewal = setInterval(() => {
      void this.client
        .eval(RedisAuditAppendCoordinator.renewScript, 1, key, token, String(leaseMs))
        .then((result) => {
          if (Number(result) !== 1) leaseState.lost = true;
        })
        .catch(() => {
          leaseState.lost = true;
        });
    }, renewalIntervalMs);
    renewal.unref();
    try {
      const result = await operation();
      if (leaseState.lost) throw new Error('Audit append lock lease was lost');
      return result;
    } finally {
      clearInterval(renewal);
      await this.client.eval(RedisAuditAppendCoordinator.releaseScript, 1, key, token);
    }
  }
}

const maxAuditVerificationErrors = 50;

export function createAuditExportManifest(
  organizationId: string,
  events: readonly AuditEvent[],
  content: string,
  generatedAt = new Date(),
): AuditExportManifest {
  if (organizationId.trim() === '') throw new ValidationError('Audit organization is required');
  if (events.some((event) => event.organizationId !== organizationId))
    throw new ValidationError('Audit export contains a cross-organization event');
  const first = events[0];
  const last = events.at(-1);
  return {
    version: 1,
    format: 'ndjson',
    organizationId,
    eventCount: events.length,
    ...(first === undefined ? {} : { firstEventId: first.id }),
    ...(last === undefined ? {} : { lastEventId: last.id }),
    ...(last?.metadata?.__auditHash === undefined ? {} : { headHash: last.metadata.__auditHash }),
    contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    generatedAt: generatedAt.toISOString(),
  };
}

export function verifyAuditExportManifest(
  manifest: AuditExportManifest,
  content: string,
): AuditExportVerificationResult {
  const errors: string[] = [];
  if (manifest.organizationId.trim() === '') errors.push('Audit export organization is required');
  if (createHash('sha256').update(content, 'utf8').digest('hex') !== manifest.contentSha256)
    errors.push('Audit export content hash mismatch');
  const lines = content === '' ? [] : content.trimEnd().split('\n');
  const events: AuditEvent[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('event is not an object');
      const event = value as AuditEvent;
      if (event.organizationId !== manifest.organizationId)
        throw new Error('event belongs to another organization');
      events.push(event);
    } catch (error) {
      errors.push(`Invalid audit export line ${String(index + 1)}: ${errorMessage(error)}`);
    }
  }
  if (events.length !== manifest.eventCount) errors.push('Audit export event count mismatch');
  if (events[0]?.id !== manifest.firstEventId) errors.push('Audit export first event mismatch');
  if (events.at(-1)?.id !== manifest.lastEventId) errors.push('Audit export last event mismatch');
  const headHash = events.at(-1)?.metadata?.__auditHash;
  if (headHash !== manifest.headHash) errors.push('Audit export head hash mismatch');
  return { valid: errors.length === 0, errors };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export interface SiemExporter {
  export(events: readonly AuditEvent[]): Promise<void>;
}

export type SiemExportFormat = 'jsonl' | 'cef' | 'syslog';

/** External immutable/WORM boundary used for append-only audit archives. */
export interface WormAuditStore {
  putIfAbsent(key: string, content: string): Promise<void>;
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
  private readonly appendTails = new Map<string, Promise<void>>();

  constructor(
    private readonly sink: AuditSink,
    private readonly coordinator?: AuditAppendCoordinator,
  ) {}

  query(organizationId: string, action?: string): Promise<readonly AuditEvent[]> {
    return this.sink.query(organizationId, action);
  }

  async append(event: AuditEvent): Promise<AuditReceipt> {
    validateEvent(event);
    const previous = this.appendTails.get(event.organizationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.appendTails.set(event.organizationId, tail);
    try {
      await previous;
      const append = async (): Promise<AuditReceipt> => {
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
      };
      return this.coordinator === undefined
        ? await append()
        : await this.coordinator.withOrganizationLock(event.organizationId, append);
    } finally {
      release();
      if (this.appendTails.get(event.organizationId) === tail)
        this.appendTails.delete(event.organizationId);
    }
  }

  async verify(range: AuditRange): Promise<AuditVerificationResult> {
    const allEvents = await this.sink.query(range.organizationId);
    const startIndex = allEvents.findIndex((event) => {
      const time = event.timestamp.getTime();
      return range.from === undefined || time >= range.from.getTime();
    });
    const events = allEvents.filter((event) => {
      const time = event.timestamp.getTime();
      return (
        (range.from === undefined || time >= range.from.getTime()) &&
        (range.to === undefined || time <= range.to.getTime())
      );
    });
    const errors: string[] = [];
    let previousHash =
      startIndex > 0 ? (allEvents[startIndex - 1]?.metadata?.__auditHash ?? 'GENESIS') : 'GENESIS';
    let previousSequence =
      startIndex > 0
        ? Number(allEvents[startIndex - 1]?.metadata?.__auditSequence ?? startIndex - 1)
        : -1;
    const reportError = (message: string): void => {
      if (errors.length < maxAuditVerificationErrors) errors.push(message);
    };
    events.forEach((event, index) => {
      const metadata = event.metadata ?? {};
      const sequence = Number(metadata.__auditSequence ?? startIndex + index);
      if (!Number.isSafeInteger(sequence) || sequence !== previousSequence + 1) {
        reportError(`${event.id}: sequence mismatch`);
      }
      const expected = hashEvent(event, sequence, previousHash);
      if (metadata.__auditPreviousHash !== previousHash)
        reportError(`${event.id}: previous hash mismatch`);
      if (metadata.__auditHash !== expected) reportError(`${event.id}: hash mismatch`);
      previousHash = metadata.__auditHash ?? expected;
      previousSequence = sequence;
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
  readonly context?: {
    readonly requestId: string;
    readonly traceId: string;
    readonly principalId: string;
    readonly source: string;
  };
}

/** Maps webhook lifecycle events to append-only audit events without storing
 * payloads or credentials.  Dispatchers may pass this directly as their
 * WebhookAuditSink because the method signatures are compatible. */
export class WebhookAuditBridge {
  constructor(
    private readonly sink: { append(event: AuditEvent): Promise<unknown> },
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
      ...(input.context === undefined ? {} : { traceId: input.context.traceId }),
      metadata: {
        event: input.event,
        attempt: String(input.attempt),
        ...(input.context === undefined
          ? {}
          : {
              requestId: input.context.requestId,
              principalId: input.context.principalId,
              source: input.context.source,
            }),
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

/**
 * Formats already-redacted audit events for common SIEM ingestion protocols.
 * The sender owns delivery, retry and backpressure; this adapter only creates
 * one deterministic payload per export call and never includes raw sensitive
 * metadata keys.
 */
export class FormattedSiemExporter implements SiemExporter {
  constructor(
    private readonly send: (payload: string) => Promise<void>,
    private readonly format: SiemExportFormat = 'jsonl',
    private readonly redactKeys: readonly string[] = ['prompt', 'response', 'token', 'secret'],
  ) {}

  async export(events: readonly AuditEvent[]): Promise<void> {
    const sanitized = redactAuditEvents(events, this.redactKeys);
    await this.send(formatAuditEvents(sanitized, this.format));
  }
}

/** Archives one tenant-scoped, redacted export under an immutable object key. */
export class WormAuditExporter implements SiemExporter {
  constructor(
    private readonly store: WormAuditStore,
    private readonly format: SiemExportFormat = 'jsonl',
    private readonly namespace = 'handstack/audit',
    private readonly redactKeys: readonly string[] = ['prompt', 'response', 'token', 'secret'],
  ) {
    if (namespace.trim() === '') throw new ValidationError('Audit WORM namespace is required');
  }

  async export(events: readonly AuditEvent[]): Promise<void> {
    if (events.length === 0) return;
    const organizations = new Set(events.map((event) => event.organizationId));
    if (organizations.size !== 1)
      throw new ValidationError('Audit WORM export must contain one organization');
    const organizationId = events[0]?.organizationId;
    const firstEventId = events[0]?.id;
    const lastEventId = events.at(-1)?.id;
    if (organizationId === undefined || firstEventId === undefined || lastEventId === undefined)
      throw new ValidationError('Audit WORM export requires event identity');
    const key = `${this.namespace}/${encodeURIComponent(organizationId)}/${encodeURIComponent(firstEventId)}-${encodeURIComponent(lastEventId)}.${this.format}`;
    await this.store.putIfAbsent(
      key,
      formatAuditEvents(redactAuditEvents(events, this.redactKeys), this.format),
    );
  }
}

export function formatAuditEvents(events: readonly AuditEvent[], format: SiemExportFormat): string {
  if (format === 'jsonl')
    return events.length === 0
      ? ''
      : `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  if (format === 'cef') return events.map(formatCefAuditEvent).join('\n');
  return events.map(formatSyslogAuditEvent).join('\n');
}

function redactAuditEvents(
  events: readonly AuditEvent[],
  redactKeys: readonly string[],
): readonly AuditEvent[] {
  const normalizedKeys = new Set(redactKeys.map((key) => key.toLowerCase()));
  return events.map((event) =>
    event.metadata === undefined
      ? { ...event }
      : {
          ...event,
          metadata: Object.fromEntries(
            Object.entries(event.metadata).map(([key, value]) => [
              key,
              normalizedKeys.has(key.toLowerCase()) ? '[REDACTED]' : value,
            ]),
          ),
        },
  );
}

function formatCefAuditEvent(event: AuditEvent): string {
  const severity = event.decision === 'ALLOW' ? '5' : '10';
  const extension = [
    `rt=${String(event.timestamp.getTime())}`,
    `src=${cefEscape(event.organizationId)}`,
    `suser=${cefEscape(event.actorId)}`,
    `outcome=${cefEscape(event.decision)}`,
    `cs1Label=resourceType`,
    `cs1=${cefEscape(event.resourceType)}`,
    ...(event.resourceId === undefined
      ? []
      : [`cs2Label=resourceId`, `cs2=${cefEscape(event.resourceId)}`]),
    ...(event.traceId === undefined ? [] : [`traceId=${cefEscape(event.traceId)}`]),
    ...Object.entries(event.metadata ?? {}).map(
      ([key, value]) => `${cefEscape(key)}=${cefEscape(value)}`,
    ),
  ].join(' ');
  return `CEF:0|HandStack|Audit|1|${cefEscape(event.action)}|${cefEscape(event.resourceType)}|${severity}|${extension}`;
}

function formatSyslogAuditEvent(event: AuditEvent): string {
  const structured = [
    `org="${syslogEscape(event.organizationId)}"`,
    `actor="${syslogEscape(event.actorId)}"`,
    `action="${syslogEscape(event.action)}"`,
    `resource="${syslogEscape(event.resourceType)}"`,
    `decision="${syslogEscape(event.decision)}"`,
    ...(event.resourceId === undefined ? [] : [`resourceId="${syslogEscape(event.resourceId)}"`]),
    ...Object.entries(event.metadata ?? {}).map(
      ([key, value]) => `${syslogEscape(key)}="${syslogEscape(value)}"`,
    ),
  ].join(' ');
  return `<134>1 ${event.timestamp.toISOString()} handstack audit - - [handstack ${structured}] ${syslogEscape(event.action)}`;
}

function cefEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('=', '\\=').replaceAll('\n', ' ');
}

function syslogEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(']', '\\]');
}
