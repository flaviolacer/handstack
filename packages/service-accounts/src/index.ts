import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ValidationError } from '@handstack/shared';

export type ServiceAccountStatus = 'ACTIVE' | 'DISABLED' | 'REVOKED';

export interface ServiceAccount {
  readonly id: string;
  readonly organizationId: string;
  readonly principalType: 'SERVICE_ACCOUNT';
  readonly displayName: string;
  readonly clientId: string;
  readonly secretHash: string;
  readonly scopes: readonly string[];
  readonly status: ServiceAccountStatus;
  readonly createdAt: Date;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
}

export interface IssuedServiceAccount {
  readonly account: ServiceAccount;
  readonly secret: string;
}

export interface ServiceAccountPrincipal {
  readonly id: string;
  readonly organizationId: string;
  readonly principalType: 'SERVICE_ACCOUNT';
  readonly scopes: readonly string[];
}

export class ServiceAccountError extends Error {
  constructor(
    readonly code:
      'NOT_FOUND' | 'INVALID_CREDENTIALS' | 'DISABLED' | 'EXPIRED' | 'DUPLICATE_CLIENT',
  ) {
    super(`Service account operation failed: ${code}`);
    this.name = 'ServiceAccountError';
  }
}

export interface ServiceAccountStore {
  insert(account: ServiceAccount): Promise<void>;
  findByClientId(organizationId: string, clientId: string): Promise<ServiceAccount | undefined>;
  update(account: ServiceAccount): Promise<void>;
  list(organizationId: string): Promise<readonly ServiceAccount[]>;
}

export class InMemoryServiceAccountStore implements ServiceAccountStore {
  private readonly accounts = new Map<string, ServiceAccount>();

  insert(account: ServiceAccount): Promise<void> {
    this.accounts.set(account.id, account);
    return Promise.resolve();
  }

  findByClientId(organizationId: string, clientId: string): Promise<ServiceAccount | undefined> {
    return Promise.resolve(
      [...this.accounts.values()].find(
        (account) => account.organizationId === organizationId && account.clientId === clientId,
      ),
    );
  }

  update(account: ServiceAccount): Promise<void> {
    this.accounts.set(account.id, account);
    return Promise.resolve();
  }

  list(organizationId: string): Promise<readonly ServiceAccount[]> {
    return Promise.resolve(
      [...this.accounts.values()].filter((account) => account.organizationId === organizationId),
    );
  }
}

export class ServiceAccountService {
  constructor(
    private readonly store: ServiceAccountStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(input: {
    organizationId: string;
    displayName: string;
    scopes: readonly string[];
    expiresAt?: Date;
  }): Promise<IssuedServiceAccount> {
    if (input.organizationId === '' || input.displayName.trim() === '' || input.scopes.length === 0)
      throw new ValidationError(
        'Service account organization, display name and scopes are required',
      );
    if (
      new Set(input.scopes).size !== input.scopes.length ||
      input.scopes.some((scope) => !/^[a-z][a-z0-9._:-]{0,127}$/.test(scope))
    )
      throw new ValidationError('Service account scopes must be unique safe identifiers');
    if (input.expiresAt !== undefined && input.expiresAt <= this.now())
      throw new ValidationError('Service account expiry must be in the future');
    const timestamp = this.now();
    const id = `sa_${randomBytes(12).toString('hex')}`;
    const clientId = `client_${randomBytes(12).toString('hex')}`;
    if ((await this.store.findByClientId(input.organizationId, clientId)) !== undefined)
      throw new ServiceAccountError('DUPLICATE_CLIENT');
    const rawSecret = randomBytes(32).toString('base64url');
    const account: ServiceAccount = {
      id,
      organizationId: input.organizationId,
      principalType: 'SERVICE_ACCOUNT',
      displayName: input.displayName,
      clientId,
      secretHash: digest(rawSecret),
      scopes: [...input.scopes],
      status: 'ACTIVE',
      createdAt: timestamp,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    };
    await this.store.insert(account);
    return { account, secret: `hs_sa_${input.organizationId}.${clientId}.${rawSecret}` };
  }

  async authenticate(
    organizationId: string,
    clientId: string,
    secret: string,
  ): Promise<ServiceAccountPrincipal> {
    const account = await this.store.findByClientId(organizationId, clientId);
    if (account === undefined || !secret.startsWith(`hs_sa_${organizationId}.${clientId}.`))
      throw new ServiceAccountError('INVALID_CREDENTIALS');
    if (account.status !== 'ACTIVE') throw new ServiceAccountError('DISABLED');
    if (account.expiresAt !== undefined && account.expiresAt <= this.now())
      throw new ServiceAccountError('EXPIRED');
    const supplied = digest(secret.slice(`hs_sa_${organizationId}.${clientId}.`.length));
    if (!safeEqual(account.secretHash, supplied))
      throw new ServiceAccountError('INVALID_CREDENTIALS');
    return {
      id: account.id,
      organizationId,
      principalType: 'SERVICE_ACCOUNT',
      scopes: account.scopes,
    };
  }

  async revoke(organizationId: string, accountId: string): Promise<void> {
    const account = await this.find(organizationId, accountId);
    await this.store.update({ ...account, status: 'REVOKED', revokedAt: this.now() });
  }

  async rotate(organizationId: string, accountId: string): Promise<IssuedServiceAccount> {
    const account = await this.find(organizationId, accountId);
    if (account.status !== 'ACTIVE') throw new ServiceAccountError('DISABLED');
    const rawSecret = randomBytes(32).toString('base64url');
    const updated = { ...account, secretHash: digest(rawSecret) };
    await this.store.update(updated);
    return { account: updated, secret: `hs_sa_${organizationId}.${account.clientId}.${rawSecret}` };
  }

  list(organizationId: string): Promise<readonly ServiceAccount[]> {
    return this.store.list(organizationId);
  }

  private async find(organizationId: string, accountId: string): Promise<ServiceAccount> {
    const account = (await this.store.list(organizationId)).find((item) => item.id === accountId);
    if (account === undefined) throw new ServiceAccountError('NOT_FOUND');
    return account;
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function signServiceAccountContext(
  organizationId: string,
  accountId: string,
  signingKey: string,
): string {
  if (organizationId === '' || accountId === '' || signingKey === '')
    throw new ValidationError('Service account context is required');
  return createHmac('sha256', signingKey).update(`${organizationId}:${accountId}`).digest('hex');
}
