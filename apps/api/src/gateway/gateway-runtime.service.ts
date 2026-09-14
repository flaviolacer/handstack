import {
  VirtualApiKeyService,
  type IssuedVirtualApiKey,
  type VirtualApiKey,
} from '@handstack/gateway';
import { uuidV7 } from '@handstack/domain';
import { Inject, Injectable } from '@nestjs/common';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class GatewayRuntimeService {
  readonly keys: VirtualApiKeyService;

  constructor(
    @Inject(AuthRuntimeService) private readonly auth: AuthRuntimeService,
    @Inject(DatabaseService) database: DatabaseService,
  ) {
    const configuredPepper = process.env.HANDSTACK_GATEWAY_KEY_PEPPER;
    const pepper =
      configuredPepper ?? 'handstack-development-gateway-key-pepper-change-me-at-least-32';
    if (process.env.NODE_ENV === 'production' && configuredPepper === undefined)
      throw new Error('HANDSTACK_GATEWAY_KEY_PEPPER is required in production');
    this.keys = new VirtualApiKeyService(
      database.adapter,
      pepper,
      undefined,
      undefined,
      undefined,
      async (event) => {
        const timestamp = new Date();
        await auth.storage.forOrganization(event.organizationId).auditEvents.insert({
          id: uuidV7(timestamp.getTime()),
          tenantId: event.organizationId,
          organizationId: event.organizationId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          eventType: event.eventType,
          outcome: 'SUCCESS',
          principalId: event.ownerId,
          details: {
            keyId: event.keyId,
            ownerId: event.ownerId,
            environment: event.environment,
          },
        });
      },
    );
  }

  async issue(input: Parameters<VirtualApiKeyService['issue']>[0]): Promise<IssuedVirtualApiKey> {
    return this.keys.issue(input);
  }

  list(organizationId: string) {
    return this.keys.list(organizationId);
  }

  revoke(organizationId: string, keyId: string) {
    return this.keys.revoke(organizationId, keyId);
  }

  static publicKey(key: VirtualApiKey) {
    return {
      id: key.id,
      organizationId: key.organizationId,
      ownerId: key.ownerId,
      ownerType: key.ownerType,
      name: key.name,
      environment: key.environment,
      keyPrefix: key.keyPrefix,
      permissions: key.permissions,
      models: key.models,
      ...(key.budgetUsd === undefined ? {} : { budgetUsd: key.budgetUsd }),
      spentUsd: key.spentUsd,
      reservedUsd: key.reservedUsd,
      requestsPerMinute: key.requestsPerMinute,
      ...(key.expiresAt === undefined ? {} : { expiresAt: key.expiresAt }),
      ...(key.lastUsedAt === undefined ? {} : { lastUsedAt: key.lastUsedAt }),
      ...(key.revokedAt === undefined ? {} : { revokedAt: key.revokedAt }),
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
    };
  }
}
