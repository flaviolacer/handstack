import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseAdapter } from '@handstack/database';
import { repositoryName, uuidV7, type TenantEntity } from '@handstack/domain';

export type VirtualKeyEnvironment = 'live' | 'test';
export type VirtualKeyOwnerType = 'USER' | 'APPLICATION' | 'SERVICE_ACCOUNT';

export interface VirtualApiKey extends TenantEntity {
  readonly organizationId: string;
  readonly ownerId: string;
  readonly ownerType: VirtualKeyOwnerType;
  readonly name: string;
  readonly environment: VirtualKeyEnvironment;
  readonly keyPrefix: string;
  readonly secretHash: string;
  readonly permissions: readonly string[];
  readonly models: readonly string[];
  readonly budgetUsd?: number;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly requestsPerMinute: number;
  readonly expiresAt?: Date;
  readonly lastUsedAt?: Date;
  readonly revokedAt?: Date;
}

export interface IssuedVirtualApiKey {
  readonly key: VirtualApiKey;
  readonly secret: string;
}

export interface VirtualApiKeyAuditEvent {
  readonly organizationId: string;
  readonly eventType: 'VIRTUAL_API_KEY_ISSUED' | 'VIRTUAL_API_KEY_REVOKED';
  readonly keyId: string;
  readonly ownerId: string;
  readonly environment: VirtualKeyEnvironment;
}

export type VirtualApiKeyAuditWriter = (event: VirtualApiKeyAuditEvent) => Promise<void>;

export interface RateLimiter {
  consume(
    keyId: string,
    limit: number,
    now: Date,
  ): Promise<{ allowed: boolean; remaining: number }>;
}

export class LocalFixedWindowRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { minute: number; count: number }>();

  consume(keyId: string, limit: number, now: Date) {
    const minute = Math.floor(now.getTime() / 60_000);
    const current = this.windows.get(keyId);
    const count = current?.minute === minute ? current.count + 1 : 1;
    this.windows.set(keyId, { minute, count });
    return Promise.resolve({ allowed: count <= limit, remaining: Math.max(0, limit - count) });
  }
}

const virtualApiKeys = repositoryName('virtual-api-keys');
export const gatewayRepositories = { virtualApiKeys } as const;

function encode(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function isExpired(value: Date | string, now: Date): boolean {
  const timestamp = new Date(value).getTime();
  return !Number.isFinite(timestamp) || timestamp <= now.getTime();
}

export class VirtualApiKeyService {
  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly pepper: string,
    private readonly limiter: RateLimiter = new LocalFixedWindowRateLimiter(),
    private readonly now: () => Date = () => new Date(),
    private readonly randomSecret: () => string = () => randomBytes(32).toString('base64url'),
    private readonly audit?: VirtualApiKeyAuditWriter,
  ) {
    if (pepper.length < 32)
      throw new Error('Virtual API key pepper must be at least 32 characters');
  }

  async issue(input: {
    organizationId: string;
    ownerId: string;
    ownerType: VirtualKeyOwnerType;
    name: string;
    environment: VirtualKeyEnvironment;
    permissions: readonly string[];
    models?: readonly string[];
    budgetUsd?: number;
    requestsPerMinute?: number;
    expiresAt?: Date;
  }): Promise<IssuedVirtualApiKey> {
    if (input.organizationId === '' || input.ownerId === '' || input.name.trim() === '')
      throw new Error('Virtual API key input is incomplete');
    if (!input.permissions.includes('models.execute'))
      throw new Error('Virtual API key requires models.execute');
    const requestsPerMinute = input.requestsPerMinute ?? 60;
    if (
      !Number.isSafeInteger(requestsPerMinute) ||
      requestsPerMinute < 1 ||
      requestsPerMinute > 100_000
    )
      throw new Error('Invalid rate limit');
    if (input.budgetUsd !== undefined && (!Number.isFinite(input.budgetUsd) || input.budgetUsd < 0))
      throw new Error('Invalid budget');
    const timestamp = this.now();
    if (
      input.expiresAt !== undefined &&
      (!Number.isFinite(input.expiresAt.getTime()) ||
        input.expiresAt.getTime() <= timestamp.getTime())
    )
      throw new Error('Expiration must be in the future');
    const id = uuidV7(timestamp.getTime());
    const secretPart = this.randomSecret();
    const secret = `hs_${input.environment}_${encode(input.organizationId)}.${id}.${secretPart}`;
    const key = await this.adapter.repository<VirtualApiKey>(virtualApiKeys).insert({
      id,
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerId: input.ownerId,
      ownerType: input.ownerType,
      name: input.name.trim(),
      environment: input.environment,
      keyPrefix: secret.slice(0, 20),
      secretHash: this.digest(secretPart),
      permissions: [...new Set(input.permissions)].sort(),
      models: [...new Set(input.models ?? [])].sort(),
      requestsPerMinute,
      ...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd }),
      spentUsd: 0,
      reservedUsd: 0,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    await this.audit?.({
      organizationId: input.organizationId,
      eventType: 'VIRTUAL_API_KEY_ISSUED',
      keyId: key.id,
      ownerId: key.ownerId,
      environment: key.environment,
    });
    return { key, secret };
  }

  async list(organizationId: string) {
    return this.adapter.repository<VirtualApiKey>(virtualApiKeys).list(organizationId, {
      limit: 100,
    });
  }

  async reserveBudget(
    organizationId: string,
    id: string,
    estimateUsd: number,
  ): Promise<VirtualApiKey> {
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0)
      throw new Error('Invalid budget estimate');
    const repository = this.adapter.repository<VirtualApiKey>(virtualApiKeys);
    const key = await repository.findById(organizationId, id);
    if (key === undefined) throw new Error('Invalid virtual API key');
    const spentUsd = key.spentUsd;
    const reservedUsd = key.reservedUsd;
    if (key.budgetUsd !== undefined && spentUsd + reservedUsd + estimateUsd > key.budgetUsd)
      throw new Error('Virtual API key budget exceeded');
    const timestamp = this.now();
    return repository.update(
      {
        ...key,
        version: key.version + 1,
        updatedAt: timestamp,
        reservedUsd: reservedUsd + estimateUsd,
      },
      key.version,
    );
  }

  async settleBudget(
    organizationId: string,
    id: string,
    estimateUsd: number,
    actualUsd: number,
  ): Promise<VirtualApiKey> {
    if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new Error('Invalid budget settlement');
    const repository = this.adapter.repository<VirtualApiKey>(virtualApiKeys);
    const key = await repository.findById(organizationId, id);
    if (key === undefined) throw new Error('Invalid virtual API key');
    const timestamp = this.now();
    return repository.update(
      {
        ...key,
        version: key.version + 1,
        updatedAt: timestamp,
        reservedUsd: Math.max(0, key.reservedUsd - estimateUsd),
        spentUsd: key.spentUsd + actualUsd,
      },
      key.version,
    );
  }

  async authenticate(secret: string, model?: string): Promise<VirtualApiKey> {
    const match = /^hs_(live|test)_([A-Za-z0-9_-]+)\.([0-9a-f-]+)\.([A-Za-z0-9_-]+)$/.exec(secret);
    if (match === null) throw new Error('Invalid virtual API key');
    const [, environment, encodedOrganization, id, secretPart] = match;
    const organizationId = decode(encodedOrganization ?? '');
    const key = await this.adapter
      .repository<VirtualApiKey>(virtualApiKeys)
      .findById(organizationId, id ?? '');
    const timestamp = this.now();
    if (
      key === undefined ||
      key.environment !== environment ||
      key.revokedAt !== undefined ||
      (key.expiresAt !== undefined && isExpired(key.expiresAt, timestamp)) ||
      !this.matches(secretPart ?? '', key.secretHash) ||
      !key.permissions.includes('models.execute') ||
      (model !== undefined && key.models.length > 0 && !key.models.includes(model))
    )
      throw new Error('Invalid virtual API key');
    const rate = await this.limiter.consume(key.id, key.requestsPerMinute, timestamp);
    if (!rate.allowed) throw new Error('Virtual API key rate limit exceeded');
    return this.adapter
      .repository<VirtualApiKey>(virtualApiKeys)
      .update(
        { ...key, version: key.version + 1, updatedAt: timestamp, lastUsedAt: timestamp },
        key.version,
      );
  }

  async revoke(organizationId: string, id: string): Promise<void> {
    const repository = this.adapter.repository<VirtualApiKey>(virtualApiKeys);
    const key = await repository.findById(organizationId, id);
    if (key === undefined || key.revokedAt !== undefined) return;
    const timestamp = this.now();
    await repository.update(
      { ...key, version: key.version + 1, updatedAt: timestamp, revokedAt: timestamp },
      key.version,
    );
    await this.audit?.({
      organizationId,
      eventType: 'VIRTUAL_API_KEY_REVOKED',
      keyId: key.id,
      ownerId: key.ownerId,
      environment: key.environment,
    });
  }

  private digest(value: string) {
    return createHmac('sha256', this.pepper).update(value).digest('hex');
  }

  private matches(value: string, expected: string) {
    const actual = Buffer.from(this.digest(value));
    const stored = Buffer.from(expected);
    return actual.length === stored.length && timingSafeEqual(actual, stored);
  }
}
