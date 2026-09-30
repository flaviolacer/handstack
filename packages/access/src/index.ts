import {
  repositoryName,
  uuidV7,
  type Repository,
  type RepositoryName,
  type TenantEntity,
} from '@handstack/domain';
import { ValidationError } from '@handstack/shared';

export type AccessGrantDuration = '1h' | '4h' | '24h' | '7d' | 'permanent';
export type AccessRequestStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'REVOKED';
export interface AccessRequest {
  readonly id: string;
  readonly organizationId: string;
  readonly requesterId: string;
  readonly resource: string;
  readonly reason: string;
  readonly duration: AccessGrantDuration;
  readonly reference?: string;
  readonly status: AccessRequestStatus;
  readonly createdAt: Date;
}
export interface AccessGrant {
  readonly id: string;
  readonly organizationId: string;
  readonly requestId: string;
  readonly subjectId: string;
  readonly resource: string;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
}
export interface Notification {
  readonly id: string;
  readonly organizationId: string;
  readonly recipientId: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly readAt?: Date;
}
export interface NotificationProvider {
  notify(notification: Notification): Promise<void>;
}

export interface AccessRequestEntity
  extends TenantEntity, Omit<AccessRequest, 'id' | 'createdAt' | 'organizationId'> {
  readonly organizationId: string;
}
export interface AccessGrantEntity extends TenantEntity, Omit<AccessGrant, 'id'> {
  readonly organizationId: string;
}

export interface AccessStore {
  saveRequest(request: AccessRequestEntity): Promise<AccessRequestEntity>;
  findRequest(organizationId: string, requestId: string): Promise<AccessRequestEntity | undefined>;
  listRequests(organizationId: string): Promise<readonly AccessRequestEntity[]>;
  saveGrant(grant: AccessGrantEntity): Promise<AccessGrantEntity>;
  findGrant(organizationId: string, grantId: string): Promise<AccessGrantEntity | undefined>;
  listGrants(organizationId: string): Promise<readonly AccessGrantEntity[]>;
}

export class InMemoryAccessStore implements AccessStore {
  private readonly requests = new Map<string, AccessRequestEntity>();
  private readonly grants = new Map<string, AccessGrantEntity>();
  async saveRequest(request: AccessRequestEntity): Promise<AccessRequestEntity> {
    this.requests.set(`${request.organizationId}:${request.id}`, request);
    return await Promise.resolve(request);
  }
  async findRequest(
    organizationId: string,
    requestId: string,
  ): Promise<AccessRequestEntity | undefined> {
    return await Promise.resolve(this.requests.get(`${organizationId}:${requestId}`));
  }
  async listRequests(organizationId: string): Promise<readonly AccessRequestEntity[]> {
    return await Promise.resolve(
      [...this.requests.values()].filter((item) => item.organizationId === organizationId),
    );
  }
  async saveGrant(grant: AccessGrantEntity): Promise<AccessGrantEntity> {
    this.grants.set(`${grant.organizationId}:${grant.id}`, grant);
    return await Promise.resolve(grant);
  }
  async findGrant(organizationId: string, grantId: string): Promise<AccessGrantEntity | undefined> {
    return await Promise.resolve(this.grants.get(`${organizationId}:${grantId}`));
  }
  async listGrants(organizationId: string): Promise<readonly AccessGrantEntity[]> {
    return await Promise.resolve(
      [...this.grants.values()].filter((item) => item.organizationId === organizationId),
    );
  }
}

export class RepositoryAccessStore implements AccessStore {
  private readonly requests: Repository<AccessRequestEntity>;
  private readonly grants: Repository<AccessGrantEntity>;
  constructor(repository: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.requests = repository<AccessRequestEntity>(repositoryName('access-requests'));
    this.grants = repository<AccessGrantEntity>(repositoryName('access-grants'));
  }
  saveRequest(request: AccessRequestEntity): Promise<AccessRequestEntity> {
    return this.persist(this.requests, request);
  }
  findRequest(organizationId: string, requestId: string): Promise<AccessRequestEntity | undefined> {
    return this.requests.findById(organizationId, requestId);
  }
  async listRequests(organizationId: string): Promise<readonly AccessRequestEntity[]> {
    return (await this.requests.list(organizationId, { limit: 200 })).items;
  }
  saveGrant(grant: AccessGrantEntity): Promise<AccessGrantEntity> {
    return this.persist(this.grants, grant);
  }
  findGrant(organizationId: string, grantId: string): Promise<AccessGrantEntity | undefined> {
    return this.grants.findById(organizationId, grantId);
  }
  async listGrants(organizationId: string): Promise<readonly AccessGrantEntity[]> {
    return (await this.grants.list(organizationId, { limit: 200 })).items;
  }
  private async persist<T extends TenantEntity>(repository: Repository<T>, entity: T): Promise<T> {
    const current = await repository.findById(entity.tenantId, entity.id);
    if (current === undefined) return repository.insert(entity);
    return repository.update(
      { ...entity, version: current.version + 1, createdAt: current.createdAt },
      current.version,
    );
  }
}

const durations: Record<AccessGrantDuration, number | undefined> = {
  '1h': 3_600_000,
  '4h': 14_400_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  permanent: undefined,
};

export class InMemoryAccessService {
  private readonly requests = new Map<string, AccessRequest>();
  private readonly grants = new Map<string, AccessGrant>();
  constructor(private readonly notifications?: NotificationProvider) {}
  submit(input: Omit<AccessRequest, 'id' | 'status' | 'createdAt'>): AccessRequest {
    if (
      input.organizationId === '' ||
      input.requesterId === '' ||
      input.resource.trim() === '' ||
      input.reason.trim() === ''
    )
      throw new ValidationError('Access request identity, resource and reason are required');
    const request: AccessRequest = {
      ...input,
      id: uuidV7(),
      status: 'PENDING',
      createdAt: new Date(),
    };
    this.requests.set(this.key(request.organizationId, request.id), request);
    void this.notifications?.notify({
      id: uuidV7(),
      organizationId: request.organizationId,
      recipientId: request.requesterId,
      type: 'access.requested',
      payload: { requestId: request.id, resource: request.resource },
      createdAt: new Date(),
    });
    return request;
  }
  get(organizationId: string, requestId: string): AccessRequest {
    const request = this.requests.get(this.key(organizationId, requestId));
    if (request === undefined) throw new ValidationError('Access request not found');
    return request;
  }
  list(organizationId: string): readonly AccessRequest[] {
    return [...this.requests.values()].filter(
      (request) => request.organizationId === organizationId,
    );
  }
  approve(organizationId: string, requestId: string, approverId: string): AccessGrant {
    const request = this.get(organizationId, requestId);
    if (approverId === '' || request.status !== 'PENDING')
      throw new ValidationError('Access request is not pending');
    const approved: AccessRequest = { ...request, status: 'APPROVED' };
    this.requests.set(this.key(organizationId, requestId), approved);
    const ttl = durations[request.duration];
    const grant: AccessGrant = {
      id: uuidV7(),
      organizationId,
      requestId,
      subjectId: request.requesterId,
      resource: request.resource,
      ...(ttl === undefined ? {} : { expiresAt: new Date(Date.now() + ttl) }),
    };
    this.grants.set(this.key(organizationId, grant.id), grant);
    void this.notifications?.notify({
      id: uuidV7(),
      organizationId,
      recipientId: request.requesterId,
      type: 'access.approved',
      payload: { requestId, grantId: grant.id },
      createdAt: new Date(),
    });
    return grant;
  }
  revoke(organizationId: string, grantId: string, requestId?: string): AccessGrant {
    const grant = this.grants.get(this.key(organizationId, grantId));
    if (grant === undefined) throw new ValidationError('Access grant not found');
    if (requestId !== undefined && grant.requestId !== requestId)
      throw new ValidationError('Access grant does not belong to access request');
    const revoked = { ...grant, revokedAt: new Date() };
    this.grants.set(this.key(organizationId, grantId), revoked);
    return revoked;
  }
  grant(organizationId: string, grantId: string): AccessGrant {
    const grant = this.grants.get(this.key(organizationId, grantId));
    if (grant === undefined) throw new ValidationError('Access grant not found');
    return grant;
  }
  listGrants(organizationId: string): readonly AccessGrant[] {
    return [...this.grants.values()].filter((grant) => grant.organizationId === organizationId);
  }
  active(
    organizationId: string,
    subjectId: string,
    resource: string,
    now = new Date(),
  ): readonly AccessGrant[] {
    return [...this.grants.values()].filter(
      (grant) =>
        grant.organizationId === organizationId &&
        grant.subjectId === subjectId &&
        grant.resource === resource &&
        grant.revokedAt === undefined &&
        (grant.expiresAt === undefined || grant.expiresAt > now),
    );
  }
  private key(organizationId: string, id: string): string {
    return `${organizationId}:${id}`;
  }
}

export class DurableAccessService {
  constructor(
    private readonly store: AccessStore,
    private readonly notifications?: NotificationProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async submit(input: Omit<AccessRequest, 'id' | 'status' | 'createdAt'>): Promise<AccessRequest> {
    if (
      input.organizationId === '' ||
      input.requesterId === '' ||
      input.resource.trim() === '' ||
      input.reason.trim() === ''
    )
      throw new ValidationError('Access request identity, resource and reason are required');
    const timestamp = this.now();
    const request: AccessRequestEntity = {
      ...input,
      id: uuidV7(timestamp.getTime()),
      tenantId: input.organizationId,
      version: 1,
      status: 'PENDING',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.saveRequest(request);
    await this.notifications?.notify({
      id: uuidV7(timestamp.getTime() + 1),
      organizationId: request.organizationId,
      recipientId: request.requesterId,
      type: 'access.requested',
      payload: { requestId: request.id, resource: request.resource },
      createdAt: timestamp,
    });
    return request;
  }
  async get(organizationId: string, requestId: string): Promise<AccessRequestEntity> {
    const request = await this.store.findRequest(organizationId, requestId);
    if (request === undefined) throw new ValidationError('Access request not found');
    return request;
  }
  list(organizationId: string): Promise<readonly AccessRequestEntity[]> {
    return this.store.listRequests(organizationId);
  }
  async approve(
    organizationId: string,
    requestId: string,
    approverId: string,
  ): Promise<AccessGrant> {
    const request = await this.get(organizationId, requestId);
    if (approverId === '' || request.status !== 'PENDING')
      throw new ValidationError('Access request is not pending');
    const timestamp = this.now();
    await this.store.saveRequest({
      ...request,
      status: 'APPROVED',
      version: request.version + 1,
      updatedAt: timestamp,
    });
    const ttl = durations[request.duration];
    const grant: AccessGrantEntity = {
      id: uuidV7(timestamp.getTime() + 1),
      tenantId: organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      organizationId,
      requestId,
      subjectId: request.requesterId,
      resource: request.resource,
      ...(ttl === undefined ? {} : { expiresAt: new Date(timestamp.getTime() + ttl) }),
    };
    await this.store.saveGrant(grant);
    await this.notifications?.notify({
      id: uuidV7(timestamp.getTime() + 2),
      organizationId,
      recipientId: request.requesterId,
      type: 'access.approved',
      payload: { requestId, grantId: grant.id },
      createdAt: timestamp,
    });
    return grant;
  }
  async revoke(organizationId: string, grantId: string, requestId?: string): Promise<AccessGrant> {
    const grant = await this.store.findGrant(organizationId, grantId);
    if (grant === undefined) throw new ValidationError('Access grant not found');
    if (requestId !== undefined && grant.requestId !== requestId)
      throw new ValidationError('Access grant does not belong to access request');
    const revoked = {
      ...grant,
      version: grant.version + 1,
      updatedAt: this.now(),
      revokedAt: this.now(),
    };
    await this.store.saveGrant(revoked);
    return revoked;
  }
  async active(
    organizationId: string,
    subjectId: string,
    resource: string,
    now = this.now(),
  ): Promise<readonly AccessGrant[]> {
    return (await this.store.listGrants(organizationId))
      .map(normalizeGrant)
      .filter(
        (grant) =>
          grant.subjectId === subjectId &&
          grant.resource === resource &&
          grant.revokedAt === undefined &&
          (grant.expiresAt === undefined || grant.expiresAt > now),
      );
  }
  async listGrants(organizationId: string): Promise<readonly AccessGrantEntity[]> {
    return (await this.store.listGrants(organizationId)).map(normalizeGrant);
  }
}

function normalizeGrant(grant: AccessGrantEntity): AccessGrantEntity {
  return {
    ...grant,
    ...(grant.expiresAt === undefined ? {} : { expiresAt: new Date(grant.expiresAt) }),
    ...(grant.revokedAt === undefined ? {} : { revokedAt: new Date(grant.revokedAt) }),
  };
}

export class InMemoryNotificationProvider implements NotificationProvider {
  readonly notifications: Notification[] = [];
  notify(notification: Notification): Promise<void> {
    this.notifications.push(notification);
    return Promise.resolve();
  }
}
