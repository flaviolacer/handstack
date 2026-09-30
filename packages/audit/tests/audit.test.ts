import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryAuditSink,
  RedisAuditAppendCoordinator,
  createAuditExportManifest,
  FormattedSiemExporter,
  RedactingSiemExporter,
  RepositoryAuditSink,
  TamperEvidentAuditSink,
  WebhookAuditBridge,
  WormAuditExporter,
  type AuditEvent,
} from '../src/index.js';
import type {
  Page,
  PageRequest,
  Repository,
  RepositoryName,
  TenantEntity,
} from '@handstack/domain';

describe('audit', () => {
  it('is append-only and tenant scoped', async () => {
    const sink = new InMemoryAuditSink();
    await sink.append({
      id: '1',
      timestamp: new Date(),
      organizationId: 'org-a',
      actorId: 'u',
      actorType: 'USER',
      action: 'LOGIN',
      resourceType: 'session',
      decision: 'ALLOW',
    });
    await expect(sink.query('org-b')).resolves.toHaveLength(0);
    await expect(sink.query('org-a')).resolves.toHaveLength(1);
  });
  it('redacts sensitive SIEM metadata', async () => {
    let received: readonly Record<string, unknown>[] = [];
    const exporter = new RedactingSiemExporter((events) => {
      received = events.map((event) => event.metadata ?? {});
      return Promise.resolve();
    });
    await exporter.export([
      {
        id: '1',
        timestamp: new Date(),
        organizationId: 'org',
        actorId: 'u',
        actorType: 'USER',
        action: 'MODEL_USED',
        resourceType: 'model',
        decision: 'ALLOW',
        metadata: { prompt: 'secret', model: 'x' },
      },
    ]);
    expect(received[0]).toMatchObject({ prompt: '[REDACTED]', model: 'x' });
  });

  it.each(['jsonl', 'cef', 'syslog'] as const)(
    'formats redacted SIEM events as %s',
    async (format) => {
      let payload = '';
      const exporter = new FormattedSiemExporter((value) => {
        payload = value;
        return Promise.resolve();
      }, format);
      await exporter.export([
        {
          id: 'formatted-1',
          timestamp: new Date('2026-01-01T00:00:00Z'),
          organizationId: 'org-format',
          actorId: 'operator|1',
          actorType: 'USER',
          action: 'MODEL_USED',
          resourceType: 'model',
          decision: 'DENY',
          metadata: { prompt: 'do-not-export', model: 'x' },
        },
      ]);
      expect(payload).toContain('MODEL_USED');
      expect(payload).toContain(format === 'syslog' ? '[REDACTED\\]' : '[REDACTED]');
      expect(payload).not.toContain('do-not-export');
      if (format === 'jsonl') expect(payload).toContain('"organizationId":"org-format"');
      if (format === 'cef') expect(payload).toMatch(/^CEF:0\|HandStack\|Audit\|/);
      if (format === 'syslog') expect(payload).toMatch(/^<134>1 /);
    },
  );

  it('writes a tenant-scoped immutable WORM export without sensitive metadata', async () => {
    const writes: { key: string; content: string }[] = [];
    const exporter = new WormAuditExporter({
      putIfAbsent: (key, content) => {
        writes.push({ key, content });
        return Promise.resolve();
      },
    });
    await exporter.export([
      {
        id: 'worm-1',
        timestamp: new Date('2026-01-01T00:00:00Z'),
        organizationId: 'org-worm',
        actorId: 'system',
        actorType: 'SYSTEM',
        action: 'AUDIT_ARCHIVED',
        resourceType: 'audit',
        decision: 'ALLOW',
        metadata: { token: 'not-for-archive', scope: 'audit' },
      },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toContain('org-worm/worm-1-worm-1.jsonl');
    expect(writes[0]?.content).toContain('[REDACTED]');
    expect(writes[0]?.content).not.toContain('not-for-archive');
  });

  it('rejects a cross-tenant WORM export before writing', async () => {
    const putIfAbsent = vi.fn().mockResolvedValue(undefined);
    const exporter = new WormAuditExporter({ putIfAbsent });
    await expect(
      exporter.export([
        {
          id: 'worm-a',
          timestamp: new Date(),
          organizationId: 'org-a',
          actorId: 'system',
          actorType: 'SYSTEM',
          action: 'AUDIT_ARCHIVED',
          resourceType: 'audit',
          decision: 'ALLOW',
        },
        {
          id: 'worm-b',
          timestamp: new Date(),
          organizationId: 'org-b',
          actorId: 'system',
          actorType: 'SYSTEM',
          action: 'AUDIT_ARCHIVED',
          resourceType: 'audit',
          decision: 'ALLOW',
        },
      ]),
    ).rejects.toThrow('Audit WORM export must contain one organization');
    expect(putIfAbsent).not.toHaveBeenCalled();
  });

  it('creates a tenant-bound manifest for verified NDJSON exports', () => {
    const events: AuditEvent[] = [
      {
        id: 'manifest-1',
        timestamp: new Date('2026-01-01T00:00:00Z'),
        organizationId: 'org-manifest',
        actorId: 'system',
        actorType: 'SYSTEM',
        action: 'EXPORT',
        resourceType: 'audit',
        decision: 'ALLOW',
      },
    ];
    const event = events[0];
    if (event === undefined) throw new Error('Expected manifest event');
    const content = `${JSON.stringify(event)}\n`;
    const manifest = createAuditExportManifest(
      'org-manifest',
      events,
      content,
      new Date('2026-01-01T00:00:02Z'),
    );
    expect(manifest).toMatchObject({
      version: 1,
      format: 'ndjson',
      organizationId: 'org-manifest',
      eventCount: 1,
      firstEventId: 'manifest-1',
      lastEventId: 'manifest-1',
      generatedAt: '2026-01-01T00:00:02.000Z',
    });
    expect(manifest.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      createAuditExportManifest(
        'org-manifest',
        [{ ...event, organizationId: 'org-other' }],
        content,
      ),
    ).toThrow('cross-organization');
  });

  it('bridges webhook lifecycle events without persisting payloads', async () => {
    const sink = new InMemoryAuditSink();
    const bridge = new WebhookAuditBridge(sink, 'system-webhooks');
    await bridge.record({
      type: 'webhook.failed',
      organizationId: 'org-a',
      deliveryId: 'delivery-1',
      event: 'agent.completed',
      attempt: 2,
      error: 'endpoint unavailable',
      context: {
        requestId: 'request-webhook',
        traceId: 'trace-webhook',
        principalId: 'principal-webhook',
        source: 'API',
      },
    });
    const [event] = await sink.query('org-a');
    expect(event).toMatchObject({
      actorId: 'system-webhooks',
      action: 'WEBHOOK_FAILED',
      resourceType: 'webhook_delivery',
      resourceId: 'delivery-1',
      decision: 'DENY',
      metadata: {
        event: 'agent.completed',
        attempt: '2',
        error: 'endpoint unavailable',
        requestId: 'request-webhook',
        principalId: 'principal-webhook',
        source: 'API',
      },
      traceId: 'trace-webhook',
    });
    expect(event?.metadata).not.toHaveProperty('payload');
  });

  it('persists audit events append-only with tenant isolation', async () => {
    const repository = new FakeRepository();
    const sink = new RepositoryAuditSink(
      (() => repository) as <T extends TenantEntity>(name: RepositoryName) => Repository<T>,
    );
    await sink.append({
      id: 'event-1',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      organizationId: 'org-a',
      actorId: 'user-1',
      actorType: 'USER',
      action: 'LOGIN',
      resourceType: 'session',
      decision: 'ALLOW',
    });
    await sink.append({
      id: 'event-2',
      timestamp: new Date('2026-01-01T00:00:01Z'),
      organizationId: 'org-a',
      actorId: 'user-1',
      actorType: 'USER',
      action: 'DENIED',
      resourceType: 'secret',
      decision: 'DENY',
    });
    await expect(sink.query('org-b')).resolves.toHaveLength(0);
    await expect(sink.query('org-a', 'LOGIN')).resolves.toMatchObject([{ id: 'event-1' }]);
    await expect(
      sink.append({
        id: '',
        timestamp: new Date(),
        organizationId: 'org-a',
        actorId: 'x',
        actorType: 'SYSTEM',
        action: 'INVALID',
        resourceType: 'x',
        decision: 'DENY',
      }),
    ).rejects.toThrow('Audit event identity is required');
  });

  it('verifies a persisted hash chain and detects tampering', async () => {
    const base = new InMemoryAuditSink();
    const sink = new TamperEvidentAuditSink(base);
    const event: AuditEvent = {
      id: 'chain-1',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      organizationId: 'org-a',
      actorId: 'user-1',
      actorType: 'USER',
      action: 'LOGIN',
      resourceType: 'session',
      decision: 'ALLOW',
    };
    await sink.append(event);
    await sink.append({ ...event, id: 'chain-2', action: 'LOGOUT' });
    await expect(sink.verify({ organizationId: 'org-a' })).resolves.toMatchObject({
      valid: true,
      checked: 2,
    });
    const stored = await base.query('org-a');
    const first = stored[0];
    const second = stored[1];
    if (first === undefined || second === undefined) throw new Error('Expected two audit events');
    const tampered: AuditEvent = { ...second, action: 'ADMIN_DELETE' };
    const replacement = new InMemoryAuditSink();
    await replacement.append(first);
    await replacement.append(tampered);
    await expect(
      new TamperEvidentAuditSink(replacement).verify({ organizationId: 'org-a' }),
    ).resolves.toMatchObject({
      valid: false,
      checked: 2,
    });
  });

  it('serializes concurrent appends per organization', async () => {
    const base = new InMemoryAuditSink();
    const sink = new TamperEvidentAuditSink(base);
    const events = Array.from({ length: 12 }, (_, index): AuditEvent => ({
      id: `concurrent-${String(index)}`,
      timestamp: new Date(`2026-01-01T00:00:${String(index).padStart(2, '0')}Z`),
      organizationId: 'org-concurrent',
      actorId: 'system',
      actorType: 'SYSTEM',
      action: 'CONCURRENT_APPEND',
      resourceType: 'audit',
      decision: 'ALLOW',
    }));

    await Promise.all(events.map((event) => sink.append(event)));

    const stored = await base.query('org-concurrent');
    expect(stored.map((event) => event.metadata?.__auditSequence)).toEqual(
      events.map((_, index) => String(index)),
    );
    await expect(sink.verify({ organizationId: 'org-concurrent' })).resolves.toMatchObject({
      valid: true,
      checked: events.length,
    });
  });

  it('coordinates the append critical section through a distributed lock client', async () => {
    const base = new InMemoryAuditSink();
    const client = new FakeAuditLockClient();
    const coordinator = new RedisAuditAppendCoordinator(client, {
      waitMs: 100,
      retryMs: 1,
    });
    const sink = new TamperEvidentAuditSink(base, coordinator);
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        sink.append({
          id: `locked-${String(index)}`,
          timestamp: new Date(`2026-01-01T00:00:0${String(index)}Z`),
          organizationId: 'org-locked',
          actorId: 'system',
          actorType: 'SYSTEM',
          action: 'LOCKED_APPEND',
          resourceType: 'audit',
          decision: 'ALLOW',
        }),
      ),
    );
    expect(client.acquisitions).toBe(4);
    expect(client.releases).toBe(4);
    await expect(sink.verify({ organizationId: 'org-locked' })).resolves.toMatchObject({
      valid: true,
      checked: 4,
    });
  });

  it('keeps the chain valid when two sink instances share the distributed lock', async () => {
    const base = new InMemoryAuditSink();
    const client = new FakeAuditLockClient();
    const first = new TamperEvidentAuditSink(
      base,
      new RedisAuditAppendCoordinator(client, { waitMs: 500, retryMs: 1 }),
    );
    const second = new TamperEvidentAuditSink(
      base,
      new RedisAuditAppendCoordinator(client, { waitMs: 500, retryMs: 1 }),
    );
    const append = (sink: TamperEvidentAuditSink, id: string) =>
      sink.append({
        id,
        timestamp: new Date(),
        organizationId: 'org-two-sinks',
        actorId: 'system',
        actorType: 'SYSTEM',
        action: 'TWO_SINKS',
        resourceType: 'audit',
        decision: 'ALLOW',
      });
    await Promise.all([
      append(first, 'two-sinks-1'),
      append(second, 'two-sinks-2'),
      append(first, 'two-sinks-3'),
      append(second, 'two-sinks-4'),
    ]);
    await expect(first.verify({ organizationId: 'org-two-sinks' })).resolves.toMatchObject({
      valid: true,
      checked: 4,
    });
  });

  it('renews a long-running lease before releasing it', async () => {
    const client = new FakeAuditLockClient();
    const coordinator = new RedisAuditAppendCoordinator(client, {
      leaseMs: 1_000,
      waitMs: 100,
      retryMs: 1,
    });
    await coordinator.withOrganizationLock('org-renewal', async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(client.renewals).toBeGreaterThanOrEqual(1);
    expect(client.releases).toBe(1);
  });

  it('fails closed when lease renewal is rejected', async () => {
    const client = new FakeAuditLockClient();
    client.rejectRenewal = true;
    const coordinator = new RedisAuditAppendCoordinator(client, {
      leaseMs: 1_000,
      waitMs: 100,
      retryMs: 1,
    });
    await expect(
      coordinator.withOrganizationLock('org-lost-lease', async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }),
    ).rejects.toThrow('Audit append lock lease was lost');
    expect(client.releases).toBe(1);
  });

  it('bounds verification diagnostics for a large corrupted stream', async () => {
    const base = new InMemoryAuditSink();
    const sink = new TamperEvidentAuditSink(base);
    for (let index = 0; index < 60; index += 1) {
      await base.append({
        id: `corrupt-${String(index)}`,
        timestamp: new Date(`2026-01-01T00:00:${String(index).padStart(2, '0')}Z`),
        organizationId: 'org-corrupt',
        actorId: 'system',
        actorType: 'SYSTEM',
        action: 'CORRUPTED',
        resourceType: 'audit',
        decision: 'ALLOW',
        metadata: {
          __auditSequence: 'not-a-sequence',
          __auditPreviousHash: 'tampered',
          __auditHash: 'tampered',
        },
      });
    }

    const result = await sink.verify({ organizationId: 'org-corrupt' });
    expect(result.valid).toBe(false);
    expect(result.checked).toBe(60);
    expect(result.errors).toHaveLength(50);
  });

  it('anchors partial verification to the preceding chain entry', async () => {
    const base = new InMemoryAuditSink();
    const sink = new TamperEvidentAuditSink(base);
    await sink.append({
      id: 'range-1',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      organizationId: 'org-range',
      actorId: 'system',
      actorType: 'SYSTEM',
      action: 'FIRST',
      resourceType: 'test',
      decision: 'ALLOW',
    });
    await sink.append({
      id: 'range-2',
      timestamp: new Date('2026-01-01T00:00:01Z'),
      organizationId: 'org-range',
      actorId: 'system',
      actorType: 'SYSTEM',
      action: 'SECOND',
      resourceType: 'test',
      decision: 'ALLOW',
    });
    await expect(
      sink.verify({ organizationId: 'org-range', from: new Date('2026-01-01T00:00:01Z') }),
    ).resolves.toMatchObject({ valid: true, checked: 1 });

    const stored = await base.query('org-range');
    const first = stored[0];
    const second = stored[1];
    if (first === undefined || second === undefined) throw new Error('Expected two range events');
    const replacement = new InMemoryAuditSink();
    await replacement.append({
      ...first,
      metadata: { ...(first.metadata ?? {}), __auditHash: 'tampered' },
    });
    await replacement.append(second);
    await expect(
      new TamperEvidentAuditSink(replacement).verify({
        organizationId: 'org-range',
        from: new Date('2026-01-01T00:00:01Z'),
      }),
    ).resolves.toMatchObject({ valid: false, checked: 1 });
  });

  it('creates a signed checkpoint scoped to the organization', async () => {
    const sink = new TamperEvidentAuditSink(new InMemoryAuditSink());
    await sink.append({
      id: 'checkpoint-1',
      timestamp: new Date(),
      organizationId: 'org-a',
      actorId: 'system',
      actorType: 'SYSTEM',
      action: 'CHECK',
      resourceType: 'audit',
      decision: 'ALLOW',
    });
    const checkpoint = await sink.checkpoint('org-a', 'test-signing-key');
    expect(checkpoint).toMatchObject({
      organizationId: 'org-a',
      sequence: 0,
      eventId: 'checkpoint-1',
    });
    expect(checkpoint.signature).toMatch(/^[a-f0-9]{64}$/);
  });
});

interface StoredAuditEntity extends TenantEntity {
  readonly organizationId: string;
  readonly event: AuditEvent;
}

class FakeRepository implements Repository<StoredAuditEntity> {
  private readonly values = new Map<string, StoredAuditEntity>();
  findById(tenantId: string, id: string) {
    return Promise.resolve(this.values.get(`${tenantId}:${id}`));
  }
  list(tenantId: string, page: PageRequest): Promise<Page<StoredAuditEntity>> {
    const items = [...this.values.values()]
      .filter((value) => value.tenantId === tenantId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const start =
      page.cursor === undefined ? 0 : items.findIndex((value) => value.id === page.cursor) + 1;
    const selected = items.slice(start, start + page.limit);
    const last = selected.at(-1);
    if (start + page.limit < items.length && last !== undefined)
      return Promise.resolve({ items: selected, nextCursor: last.id });
    return Promise.resolve({ items: selected });
  }
  insert(entity: StoredAuditEntity) {
    this.values.set(`${entity.tenantId}:${entity.id}`, entity);
    return Promise.resolve(entity);
  }
  update(): Promise<StoredAuditEntity> {
    return Promise.reject(new Error('append-only'));
  }
  delete(): Promise<boolean> {
    return Promise.reject(new Error('append-only'));
  }
}

class FakeAuditLockClient {
  private locked = false;
  private lastKey = '';
  private lastValue = '';
  private lastOptions: readonly string[] = [];
  private lastScript = '';
  private lastNumberOfKeys = 0;
  private lastArguments: readonly string[] = [];
  acquisitions = 0;
  releases = 0;
  renewals = 0;
  rejectRenewal = false;

  set(_key: string, _value: string, ..._options: readonly string[]): Promise<string | null> {
    this.lastKey = _key;
    this.lastValue = _value;
    this.lastOptions = _options;
    if (this.locked) return Promise.resolve(null);
    this.locked = true;
    this.acquisitions += 1;
    return Promise.resolve('OK');
  }

  eval(_script: string, _numberOfKeys: number, ..._arguments: readonly string[]): Promise<unknown> {
    this.lastScript = _script;
    this.lastNumberOfKeys = _numberOfKeys;
    this.lastArguments = _arguments;
    if (_script.includes('pexpire')) {
      this.renewals += 1;
      if (this.rejectRenewal) return Promise.resolve(0);
    } else {
      this.locked = false;
      this.releases += 1;
    }
    return Promise.resolve(1);
  }
}
