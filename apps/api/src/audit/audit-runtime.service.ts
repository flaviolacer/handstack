import { Injectable } from '@nestjs/common';
import {
  InMemoryAuditSink,
  RepositoryAuditSink,
  WebhookAuditBridge,
  type AuditActorType,
  type AuditEvent,
  type AuditSink,
} from '@handstack/audit';
import { DatabaseService } from '../database/database.service.js';
import { randomUUID } from 'node:crypto';

/** Process-local audit boundary used by API integrations until a durable audit
 * repository/SIEM adapter is provisioned. The sink remains append-only and
 * tenant-scoped, so callers can replace it without changing webhook code. */
@Injectable()
export class AuditRuntimeService {
  private readonly sink: AuditSink;
  readonly webhook: WebhookAuditBridge;

  constructor(database?: DatabaseService) {
    this.sink =
      database === undefined
        ? new InMemoryAuditSink()
        : new RepositoryAuditSink((name) => database.adapter.repository(name));
    this.webhook = new WebhookAuditBridge(this.sink);
  }

  query(organizationId: string, action?: string): Promise<readonly AuditEvent[]> {
    return this.sink.query(organizationId, action);
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
  }): Promise<void> {
    await this.sink.append({
      id: randomUUID(),
      timestamp: new Date(),
      organizationId: input.organizationId,
      actorId: input.actorId,
      actorType: input.actorType ?? 'USER',
      action: input.action,
      resourceType: input.resourceType,
      ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      decision: input.decision ?? 'ALLOW',
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
  }
}
