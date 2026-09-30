import { MasterKey, openSecret, sealSecret, secretAad } from '@handstack/core';
import { repositoryName, type Repository, type TenantEntity } from '@handstack/domain';
import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { AuditRuntimeService } from '../audit/audit-runtime.service.js';

export interface SecretMetadata {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly pluginId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SecretEntity extends TenantEntity {
  readonly organizationId: string;
  readonly name: string;
  readonly pluginId: string;
  readonly envelope: string;
}

const secretsRepository = repositoryName('secrets');

@Injectable()
export class SecretRuntimeService {
  private readonly secrets: Repository<SecretEntity>;
  private readonly masterKey: MasterKey | undefined;

  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(AuditRuntimeService) private readonly audit: AuditRuntimeService,
  ) {
    this.secrets = database.adapter.repository(secretsRepository);
    const configuredMasterKey = database.config.security.masterKey;
    this.masterKey =
      configuredMasterKey === undefined ? undefined : MasterKey.decode(configuredMasterKey);
  }

  list(organizationId: string): Promise<{ items: SecretMetadata[]; nextCursor?: string }> {
    return this.secrets.list(organizationId, { limit: 200 }).then((page) => ({
      items: page.items.map((secret) => this.metadata(secret)),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    }));
  }

  async create(input: {
    organizationId: string;
    actorId: string;
    name: string;
    pluginId: string;
    value: string;
  }) {
    const key = this.requireMasterKey();
    const now = new Date();
    const entity: SecretEntity = {
      id: crypto.randomUUID(),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      name: input.name,
      pluginId: input.pluginId,
      envelope: sealSecret(
        input.value,
        key.derive('secret-encryption'),
        secretAad({ organizationId: input.organizationId, pluginId: input.pluginId }),
      ),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.secrets.insert(entity);
    await this.audit.record({
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: 'secret.create',
      resourceType: 'secret',
      resourceId: created.id,
      metadata: { name: created.name, pluginId: created.pluginId },
    });
    return this.metadata(created);
  }

  async rotate(
    organizationId: string,
    actorId: string,
    id: string,
    value: string,
  ): Promise<SecretMetadata> {
    const key = this.requireMasterKey();
    const existing = await this.secrets.findById(organizationId, id);
    if (existing === undefined) throw new Error('Secret not found');
    const updated: SecretEntity = {
      ...existing,
      envelope: sealSecret(
        value,
        key.derive('secret-encryption'),
        secretAad({ organizationId, pluginId: existing.pluginId }),
      ),
      version: existing.version + 1,
      updatedAt: new Date(),
    };
    const rotated = await this.secrets.update(updated, existing.version);
    await this.audit.record({
      organizationId,
      actorId,
      action: 'secret.rotate',
      resourceType: 'secret',
      resourceId: rotated.id,
      metadata: { name: rotated.name, pluginId: rotated.pluginId },
    });
    return this.metadata(rotated);
  }

  async remove(organizationId: string, actorId: string, id: string): Promise<void> {
    const existing = await this.secrets.findById(organizationId, id);
    if (existing === undefined) throw new Error('Secret not found');
    await this.secrets.delete(organizationId, id, existing.version);
    await this.audit.record({
      organizationId,
      actorId,
      action: 'secret.delete',
      resourceType: 'secret',
      resourceId: id,
      metadata: { name: existing.name, pluginId: existing.pluginId },
    });
  }

  async resolve(
    reference: string,
    organizationId: string,
    pluginId: string,
  ): Promise<string | undefined> {
    if (reference.startsWith('env://')) {
      const match = /^env:\/\/(HANDSTACK_SECRET_[A-Z0-9_]+)$/.exec(reference);
      if (match?.[1] === undefined) throw new TypeError('Unsupported secret reference');
      const value = process.env[match[1]];
      if (value === undefined) return undefined;
      await this.audit.record({
        organizationId,
        actorId: 'system:secret-provider',
        actorType: 'SYSTEM',
        action: 'SECRET_ACCESSED',
        resourceType: 'secret-provider',
        resourceId: match[1],
        metadata: { name: match[1], pluginId, provider: 'environment' },
      });
      return value;
    }
    const id = reference.startsWith('secret://') ? reference.slice('secret://'.length) : reference;
    const entity = await this.secrets.findById(organizationId, id);
    if (entity?.pluginId !== pluginId) return undefined;
    const value = openSecret(
      entity.envelope,
      this.requireMasterKey().derive('secret-encryption'),
      secretAad({ organizationId, pluginId }),
    );
    await this.audit.record({
      organizationId,
      actorId: 'system:secret-provider',
      actorType: 'SYSTEM',
      action: 'SECRET_ACCESSED',
      resourceType: 'secret',
      resourceId: entity.id,
      metadata: { name: entity.name, pluginId: entity.pluginId },
    });
    return value;
  }

  private requireMasterKey(): MasterKey {
    if (this.masterKey === undefined)
      throw new Error('HANDSTACK_MASTER_KEY is required for secret management');
    return this.masterKey;
  }

  private metadata(secret: SecretEntity): SecretMetadata {
    return {
      id: secret.id,
      organizationId: secret.organizationId,
      name: secret.name,
      pluginId: secret.pluginId,
      createdAt: secret.createdAt.toISOString(),
      updatedAt: secret.updatedAt.toISOString(),
    };
  }
}
