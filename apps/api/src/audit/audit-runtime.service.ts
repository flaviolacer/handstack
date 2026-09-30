import { Injectable } from '@nestjs/common';
import {
  InMemoryAuditSink,
  RepositoryAuditSink,
  TamperEvidentAuditSink,
  WebhookAuditBridge,
  type AuditActorType,
  type AuditEvent,
} from '@handstack/audit';
import { DatabaseService } from '../database/database.service.js';
import { randomUUID } from 'node:crypto';
import { EventBusRuntimeService } from '../core/event-bus-runtime.service.js';
import { publishRuntimeDomainEvent } from '../core/runtime-domain-event.js';
import type { DomainEventContext } from '@handstack/core';

/** Process-local audit boundary used by API integrations until a durable audit
 * repository/SIEM adapter is provisioned. The sink remains append-only and
 * tenant-scoped, so callers can replace it without changing webhook code. */
@Injectable()
export class AuditRuntimeService {
  private readonly sink: TamperEvidentAuditSink;
  readonly webhook: WebhookAuditBridge;

  constructor(database?: DatabaseService, eventBus?: EventBusRuntimeService) {
    this.eventBus = eventBus?.bus;
    const durableSink =
      database === undefined
        ? new InMemoryAuditSink()
        : new RepositoryAuditSink((name) => database.adapter.repository(name));
    this.sink = new TamperEvidentAuditSink(durableSink, eventBus?.auditAppendCoordinator);
    this.webhook = new WebhookAuditBridge(this.sink);
  }

  private readonly eventBus: EventBusRuntimeService['bus'] | undefined;

  query(organizationId: string, action?: string): Promise<readonly AuditEvent[]> {
    return this.sink.query(organizationId, action);
  }

  verify(organizationId: string) {
    return this.sink.verify({ organizationId });
  }

  checkpoint(organizationId: string, signingKey: string) {
    return this.sink.checkpoint(organizationId, signingKey);
  }

  async record(input: {
    organizationId: string;
    actorId: string;
    actorType?: AuditActorType;
    action: string;
    resourceType: string;
    resourceId?: string;
    decision?: 'ALLOW' | 'DENY';
    metadata?: Readonly<Record<string, string>>;
    context?: DomainEventContext;
  }): Promise<void> {
    const event = {
      id: randomUUID(),
      timestamp: new Date(),
      organizationId: input.organizationId,
      actorId: input.actorId,
      actorType: input.actorType ?? 'USER',
      action: input.action,
      resourceType: input.resourceType,
      ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      decision: input.decision ?? 'ALLOW',
      ...(input.context === undefined ? {} : { traceId: input.context.traceId }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    } satisfies AuditEvent;
    await this.sink.append(event);
    await publishRuntimeDomainEvent(this.eventBus, {
      organizationId: event.organizationId,
      type: 'audit.recorded',
      ...(input.context === undefined ? {} : { context: input.context }),
      payload: {
        auditEventId: event.id,
        action: event.action,
        resourceType: event.resourceType,
        ...(event.resourceId === undefined ? {} : { resourceId: event.resourceId }),
        decision: event.decision,
      },
    });
  }
}
