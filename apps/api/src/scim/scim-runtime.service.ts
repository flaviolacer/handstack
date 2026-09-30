import { Injectable } from '@nestjs/common';
import {
  InMemoryScimAuditSink,
  InMemoryScimCredentialStore,
  InMemoryScimStore,
  RepositoryScimCredentialStore,
  RepositoryScimStore,
  ScimCredentialService,
  ScimProvisioningService,
  TokenBucketScimRateLimiter,
  type ScimAuditEvent,
  type ScimAuditSink,
} from '@handstack/scim';
import { AuditRuntimeService } from '../audit/audit-runtime.service.js';
import { DatabaseService } from '../database/database.service.js';

const developmentScimPepper = 'handstack-development-scim-token-pepper';

function scimPepper(value?: string): string {
  if (value !== undefined) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('HANDSTACK_SCIM_TOKEN_PEPPER is required in production');
  }
  return developmentScimPepper;
}

/** Bridges the redacted SCIM audit contract onto the durable append-only audit sink. */
class ScimAuditBridge implements ScimAuditSink {
  constructor(private readonly audit: AuditRuntimeService) {}
  async record(event: ScimAuditEvent): Promise<void> {
    await this.audit.record({
      organizationId: event.organizationId,
      actorId: 'scim-provisioning',
      actorType: 'SERVICE',
      action: `SCIM_${event.action}`,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      ...(event.externalId === undefined
        ? {}
        : { metadata: { externalId: event.externalId, version: String(event.version) } }),
    });
  }
}

@Injectable()
export class ScimRuntimeService {
  readonly provisioning: ScimProvisioningService;
  readonly credentials: ScimCredentialService;

  constructor(database?: DatabaseService, audit?: AuditRuntimeService) {
    const auditSink: ScimAuditSink =
      audit === undefined ? new InMemoryScimAuditSink() : new ScimAuditBridge(audit);
    const provisioning = new ScimProvisioningService(
      database === undefined
        ? new InMemoryScimStore()
        : new RepositoryScimStore((name) => database.adapter.repository(name)),
      new TokenBucketScimRateLimiter(1000, 100),
      auditSink,
    );
    const credentials = new ScimCredentialService(
      database === undefined
        ? new InMemoryScimCredentialStore()
        : new RepositoryScimCredentialStore((name) => database.adapter.repository(name)),
      scimPepper(database?.config.security.scimTokenPepper),
    );
    this.provisioning = provisioning;
    this.credentials = credentials;
  }
}
