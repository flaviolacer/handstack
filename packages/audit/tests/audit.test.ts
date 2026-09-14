import { describe, expect, it } from 'vitest';
import {
  InMemoryAuditSink,
  RedactingSiemExporter,
  RepositoryAuditSink,
  TamperEvidentAuditSink,
  WebhookAuditBridge,
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
      },
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
