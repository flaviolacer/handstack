import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  repositoryName,
  uuidV7,
  type Repository,
  type RepositoryName,
  type TenantEntity,
} from '@handstack/domain';
import { HandStackError, RateLimitError, ValidationError } from '@handstack/shared';

// --- SCIM 2.0 (RFC 7643/7644) provisioning domain ---------------------------

export class ScimNotFoundError extends HandStackError {
  readonly code = 'scim_not_found' as const;
  readonly status = 404;
}

export class ScimConflictError extends HandStackError {
  readonly code = 'scim_conflict' as const;
  readonly status = 409;
}

export const SCIM_SCHEMAS = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  listResponse: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
} as const;

export type ScimResourceType = 'User' | 'Group';

export interface ScimMeta {
  readonly resourceType: ScimResourceType;
  readonly created: Date;
  readonly lastModified: Date;
  readonly version: number;
  readonly location: string;
}

export interface ScimUserName {
  readonly formatted?: string;
  readonly givenName?: string;
  readonly familyName?: string;
}

export interface ScimEmail {
  readonly value: string;
  readonly primary?: boolean;
  readonly type?: string;
}

export interface ScimUser {
  readonly id: string;
  readonly organizationId: string;
  readonly externalId?: string;
  readonly userName: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly name?: ScimUserName;
  readonly emails?: readonly ScimEmail[];
  readonly meta: ScimMeta;
}

export interface ScimGroupMember {
  readonly value: string;
  readonly display?: string;
}

export interface ScimGroup {
  readonly id: string;
  readonly organizationId: string;
  readonly externalId?: string;
  readonly displayName: string;
  readonly members?: readonly ScimGroupMember[];
  readonly meta: ScimMeta;
}

export interface ScimListResponse<T> {
  readonly schemas: readonly [typeof SCIM_SCHEMAS.listResponse];
  readonly totalResults: number;
  readonly startIndex: number;
  readonly itemsPerPage: number;
  readonly Resources: readonly T[];
}

export interface ScimUserInput {
  readonly externalId?: string;
  readonly userName?: string;
  readonly displayName?: string;
  readonly active?: boolean;
  readonly name?: ScimUserName;
  readonly emails?: readonly ScimEmail[];
}

export interface ScimUserPatch {
  readonly userName?: string;
  readonly displayName?: string;
  readonly active?: boolean;
  readonly name?: ScimUserName;
  readonly emails?: readonly ScimEmail[];
}

export interface ScimGroupInput {
  readonly externalId?: string;
  readonly displayName?: string;
  readonly members?: readonly ScimGroupMember[];
}

export interface ScimGroupPatch {
  readonly displayName?: string;
  readonly externalId?: string;
}

export interface ScimUserPage {
  readonly totalResults: number;
  readonly startIndex: number;
  readonly itemsPerPage: number;
  readonly users: readonly ScimUser[];
}

export interface ScimGroupPage {
  readonly totalResults: number;
  readonly startIndex: number;
  readonly itemsPerPage: number;
  readonly groups: readonly ScimGroup[];
}

// --- Persistence boundary ----------------------------------------------------

export interface ScimStore {
  findUserByExternalId(organizationId: string, externalId: string): Promise<ScimUser | undefined>;
  findUser(organizationId: string, id: string): Promise<ScimUser | undefined>;
  listUsers(organizationId: string, startIndex: number, count: number): Promise<ScimUserPage>;
  scanUsers(organizationId: string): Promise<readonly ScimUser[]>;
  insertUser(user: ScimUser): Promise<ScimUser>;
  updateUser(user: ScimUser, expectedVersion: number): Promise<ScimUser>;
  deleteUser(organizationId: string, id: string, expectedVersion: number): Promise<void>;
  findGroupByExternalId(organizationId: string, externalId: string): Promise<ScimGroup | undefined>;
  findGroup(organizationId: string, id: string): Promise<ScimGroup | undefined>;
  listGroups(organizationId: string, startIndex: number, count: number): Promise<ScimGroupPage>;
  scanGroups(organizationId: string): Promise<readonly ScimGroup[]>;
  insertGroup(group: ScimGroup): Promise<ScimGroup>;
  updateGroup(group: ScimGroup, expectedVersion: number): Promise<ScimGroup>;
  deleteGroup(organizationId: string, id: string, expectedVersion: number): Promise<void>;
}

export class InMemoryScimStore implements ScimStore {
  private readonly users = new Map<string, ScimUser>();
  private readonly groups = new Map<string, ScimGroup>();
  private readonly userExternalIds = new Map<string, string>();
  private readonly groupExternalIds = new Map<string, string>();

  findUserByExternalId(organizationId: string, externalId: string): Promise<ScimUser | undefined> {
    const key = this.userExternalIds.get(`${organizationId}:${externalId}`);
    return Promise.resolve(key === undefined ? undefined : this.users.get(key));
  }
  findUser(organizationId: string, id: string): Promise<ScimUser | undefined> {
    return Promise.resolve(this.users.get(`${organizationId}:${id}`));
  }
  listUsers(organizationId: string, startIndex: number, count: number): Promise<ScimUserPage> {
    const users = this.allUsers(organizationId);
    const slice = users.slice(startIndex - 1, startIndex - 1 + count);
    return Promise.resolve({
      totalResults: users.length,
      startIndex,
      itemsPerPage: slice.length,
      users: slice,
    });
  }
  scanUsers(organizationId: string): Promise<readonly ScimUser[]> {
    return Promise.resolve(this.allUsers(organizationId));
  }
  insertUser(user: ScimUser): Promise<ScimUser> {
    const key = `${user.organizationId}:${user.id}`;
    if (this.users.has(key)) throw new ValidationError('SCIM user id already exists');
    if (user.externalId !== undefined)
      this.userExternalIds.set(`${user.organizationId}:${user.externalId}`, key);
    this.users.set(key, user);
    return Promise.resolve(user);
  }
  updateUser(user: ScimUser, expectedVersion: number): Promise<ScimUser> {
    const key = `${user.organizationId}:${user.id}`;
    const current = this.users.get(key);
    if (current === undefined) throw new ScimNotFoundError('SCIM user not found');
    if (current.meta.version !== expectedVersion)
      throw new ScimConflictError('SCIM user version conflict');
    this.users.set(key, user);
    return Promise.resolve(user);
  }
  deleteUser(organizationId: string, id: string, expectedVersion: number): Promise<void> {
    const key = `${organizationId}:${id}`;
    const current = this.users.get(key);
    if (current === undefined) throw new ScimNotFoundError('SCIM user not found');
    if (current.meta.version !== expectedVersion)
      throw new ScimConflictError('SCIM user version conflict');
    if (current.externalId !== undefined)
      this.userExternalIds.delete(`${organizationId}:${current.externalId}`);
    this.users.delete(key);
    return Promise.resolve();
  }
  findGroupByExternalId(
    organizationId: string,
    externalId: string,
  ): Promise<ScimGroup | undefined> {
    const key = this.groupExternalIds.get(`${organizationId}:${externalId}`);
    return Promise.resolve(key === undefined ? undefined : this.groups.get(key));
  }
  findGroup(organizationId: string, id: string): Promise<ScimGroup | undefined> {
    return Promise.resolve(this.groups.get(`${organizationId}:${id}`));
  }
  listGroups(organizationId: string, startIndex: number, count: number): Promise<ScimGroupPage> {
    const groups = this.allGroups(organizationId);
    const slice = groups.slice(startIndex - 1, startIndex - 1 + count);
    return Promise.resolve({
      totalResults: groups.length,
      startIndex,
      itemsPerPage: slice.length,
      groups: slice,
    });
  }
  scanGroups(organizationId: string): Promise<readonly ScimGroup[]> {
    return Promise.resolve(this.allGroups(organizationId));
  }
  insertGroup(group: ScimGroup): Promise<ScimGroup> {
    const key = `${group.organizationId}:${group.id}`;
    if (this.groups.has(key)) throw new ValidationError('SCIM group id already exists');
    if (group.externalId !== undefined)
      this.groupExternalIds.set(`${group.organizationId}:${group.externalId}`, key);
    this.groups.set(key, group);
    return Promise.resolve(group);
  }
  updateGroup(group: ScimGroup, expectedVersion: number): Promise<ScimGroup> {
    const key = `${group.organizationId}:${group.id}`;
    const current = this.groups.get(key);
    if (current === undefined) throw new ScimNotFoundError('SCIM group not found');
    if (current.meta.version !== expectedVersion)
      throw new ScimConflictError('SCIM group version conflict');
    this.groups.set(key, group);
    return Promise.resolve(group);
  }
  deleteGroup(organizationId: string, id: string, expectedVersion: number): Promise<void> {
    const key = `${organizationId}:${id}`;
    const current = this.groups.get(key);
    if (current === undefined) throw new ScimNotFoundError('SCIM group not found');
    if (current.meta.version !== expectedVersion)
      throw new ScimConflictError('SCIM group version conflict');
    if (current.externalId !== undefined)
      this.groupExternalIds.delete(`${organizationId}:${current.externalId}`);
    this.groups.delete(key);
    return Promise.resolve();
  }

  private allUsers(organizationId: string): ScimUser[] {
    return [...this.users.values()].filter((user) => user.organizationId === organizationId);
  }
  private allGroups(organizationId: string): ScimGroup[] {
    return [...this.groups.values()].filter((group) => group.organizationId === organizationId);
  }
}

interface ScimUserEntity extends TenantEntity {
  readonly user: ScimUser;
}

interface ScimGroupEntity extends TenantEntity {
  readonly group: ScimGroup;
}

export class RepositoryScimStore implements ScimStore {
  private readonly users: Repository<ScimUserEntity>;
  private readonly groups: Repository<ScimGroupEntity>;
  constructor(repository: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.users = repository<ScimUserEntity>(repositoryName('scim-users'));
    this.groups = repository<ScimGroupEntity>(repositoryName('scim-groups'));
  }

  findUserByExternalId(organizationId: string, externalId: string): Promise<ScimUser | undefined> {
    return this.findByExternalId(organizationId, externalId, this.users, (entity) => entity.user);
  }
  findUser(organizationId: string, id: string): Promise<ScimUser | undefined> {
    return this.find(organizationId, id, this.users, (entity) => entity.user);
  }
  async listUsers(
    organizationId: string,
    startIndex: number,
    count: number,
  ): Promise<ScimUserPage> {
    const users = await this.scan(organizationId, this.users, (entity) => entity.user);
    const slice = users.slice(startIndex - 1, startIndex - 1 + count);
    return { totalResults: users.length, startIndex, itemsPerPage: slice.length, users: slice };
  }
  scanUsers(organizationId: string): Promise<readonly ScimUser[]> {
    return this.scan(organizationId, this.users, (entity) => entity.user);
  }
  insertUser(user: ScimUser): Promise<ScimUser> {
    return this.insert(this.users, user, (resource, base) => ({ ...base, user: resource }));
  }
  updateUser(user: ScimUser, expectedVersion: number): Promise<ScimUser> {
    return this.update(this.users, user, expectedVersion, (entity, resource) => ({
      ...entity,
      user: resource,
    }));
  }
  deleteUser(organizationId: string, id: string, expectedVersion: number): Promise<void> {
    return this.delete(this.users, organizationId, id, expectedVersion, 'user');
  }

  findGroupByExternalId(
    organizationId: string,
    externalId: string,
  ): Promise<ScimGroup | undefined> {
    return this.findByExternalId(organizationId, externalId, this.groups, (entity) => entity.group);
  }
  findGroup(organizationId: string, id: string): Promise<ScimGroup | undefined> {
    return this.find(organizationId, id, this.groups, (entity) => entity.group);
  }
  async listGroups(
    organizationId: string,
    startIndex: number,
    count: number,
  ): Promise<ScimGroupPage> {
    const groups = await this.scan(organizationId, this.groups, (entity) => entity.group);
    const slice = groups.slice(startIndex - 1, startIndex - 1 + count);
    return { totalResults: groups.length, startIndex, itemsPerPage: slice.length, groups: slice };
  }
  scanGroups(organizationId: string): Promise<readonly ScimGroup[]> {
    return this.scan(organizationId, this.groups, (entity) => entity.group);
  }
  insertGroup(group: ScimGroup): Promise<ScimGroup> {
    return this.insert(this.groups, group, (resource, base) => ({ ...base, group: resource }));
  }
  updateGroup(group: ScimGroup, expectedVersion: number): Promise<ScimGroup> {
    return this.update(this.groups, group, expectedVersion, (entity, resource) => ({
      ...entity,
      group: resource,
    }));
  }
  deleteGroup(organizationId: string, id: string, expectedVersion: number): Promise<void> {
    return this.delete(this.groups, organizationId, id, expectedVersion, 'group');
  }

  private async find<E extends TenantEntity, R>(
    organizationId: string,
    id: string,
    repository: Repository<E>,
    extract: (entity: E) => R,
  ): Promise<R | undefined> {
    const entity = await repository.findById(organizationId, id);
    return entity === undefined ? undefined : extract(entity);
  }
  private async findByExternalId<E extends TenantEntity, R extends ScimUser | ScimGroup>(
    organizationId: string,
    externalId: string,
    repository: Repository<E>,
    extract: (entity: E) => R,
  ): Promise<R | undefined> {
    const all = await this.scan(organizationId, repository, extract);
    return all.find((resource) => resource.externalId === externalId);
  }
  private async scan<E extends TenantEntity, R>(
    organizationId: string,
    repository: Repository<E>,
    extract: (entity: E) => R,
  ): Promise<R[]> {
    const result: R[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.list(organizationId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      result.push(...page.items.map(extract));
      if (page.nextCursor !== undefined && page.nextCursor === cursor)
        throw new ValidationError('SCIM repository cursor repeated');
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return result;
  }
  private async insert<E extends TenantEntity, R extends ScimUser | ScimGroup>(
    repository: Repository<E>,
    resource: R,
    wrap: (
      resource: R,
      base: {
        readonly id: string;
        readonly tenantId: string;
        readonly version: number;
        readonly createdAt: Date;
        readonly updatedAt: Date;
      },
    ) => E,
  ): Promise<R> {
    const timestamp = new Date();
    await repository.insert(
      wrap(resource, {
        id: resource.id,
        tenantId: resource.organizationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    return resource;
  }
  private async update<E extends TenantEntity, R extends ScimUser | ScimGroup>(
    repository: Repository<E>,
    resource: R,
    expectedVersion: number,
    wrap: (entity: E, resource: R) => E,
  ): Promise<R> {
    const entity = await repository.findById(resource.organizationId, resource.id);
    if (entity === undefined) throw new ScimNotFoundError('SCIM resource not found');
    if (entity.version !== expectedVersion)
      throw new ScimConflictError('SCIM resource version conflict');
    await repository.update(
      wrap({ ...entity, version: entity.version + 1, updatedAt: new Date() }, resource),
      entity.version,
    );
    return resource;
  }
  private async delete<E extends TenantEntity>(
    repository: Repository<E>,
    organizationId: string,
    id: string,
    expectedVersion: number,
    kind: 'user' | 'group',
  ): Promise<void> {
    const entity = await repository.findById(organizationId, id);
    if (entity === undefined) throw new ScimNotFoundError(`SCIM ${kind} not found`);
    await repository.delete(organizationId, id, expectedVersion);
  }
}

// --- Cross-cutting hooks ------------------------------------------------------

export interface ScimRateLimiter {
  consume(organizationId: string): Promise<boolean>;
}

export type ScimAuditAction =
  | 'USER_CREATED'
  | 'USER_UPDATED'
  | 'USER_DEACTIVATED'
  | 'USER_REACTIVATED'
  | 'USER_DELETED'
  | 'GROUP_CREATED'
  | 'GROUP_UPDATED'
  | 'GROUP_DELETED'
  | 'GROUP_MEMBER_ADDED'
  | 'GROUP_MEMBER_REMOVED';

export interface ScimAuditEvent {
  readonly organizationId: string;
  readonly action: ScimAuditAction;
  readonly resourceType: ScimResourceType;
  readonly resourceId: string;
  readonly externalId?: string;
  readonly version: number;
}

export interface ScimAuditSink {
  record(event: ScimAuditEvent): Promise<void>;
}

export class InMemoryScimAuditSink implements ScimAuditSink {
  readonly events: ScimAuditEvent[] = [];
  record(event: ScimAuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

export class TokenBucketScimRateLimiter implements ScimRateLimiter {
  private readonly buckets = new Map<string, { readonly tokens: number; readonly at: number }>();
  constructor(
    private readonly maximum: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isInteger(maximum) || maximum < 1)
      throw new ValidationError('Rate limit is invalid');
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0)
      throw new ValidationError('Rate limit refill is invalid');
  }
  consume(organizationId: string): Promise<boolean> {
    const nowMs = this.now();
    const current = this.buckets.get(organizationId);
    const tokens = Math.min(
      this.maximum,
      current === undefined
        ? this.maximum
        : current.tokens + ((nowMs - current.at) / 1000) * this.refillPerSecond,
    );
    if (tokens < 1) return Promise.resolve(false);
    this.buckets.set(organizationId, { tokens: tokens - 1, at: nowMs });
    return Promise.resolve(true);
  }
}

// --- Provisioning service -----------------------------------------------------

const DEFAULT_COUNT = 100;
const MAX_COUNT = 1000;

export class ScimProvisioningService {
  constructor(
    private readonly store: ScimStore,
    private readonly rateLimiter?: ScimRateLimiter,
    private readonly audit?: ScimAuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createUser(organizationId: string, input: ScimUserInput): Promise<ScimUser> {
    await this.guard(organizationId);
    const validated = validateUserInput(input);
    await this.assertUserUniqueness(organizationId, validated);
    const timestamp = this.now();
    const id = uuidV7(timestamp.getTime());
    const user: ScimUser = {
      id,
      organizationId,
      userName: validated.userName,
      displayName: validated.displayName,
      active: validated.active ?? true,
      ...(validated.externalId === undefined ? {} : { externalId: validated.externalId }),
      ...(validated.name === undefined ? {} : { name: validated.name }),
      ...(validated.emails === undefined ? {} : { emails: validated.emails }),
      meta: meta('User', userLocation(id), timestamp, 1),
    };
    await this.store.insertUser(user);
    await this.record(organizationId, 'USER_CREATED', 'User', user);
    return user;
  }

  async upsertUser(organizationId: string, input: ScimUserInput): Promise<ScimUser> {
    if (input.externalId !== undefined) {
      const existing = await this.store.findUserByExternalId(organizationId, input.externalId);
      if (existing !== undefined) return existing;
    }
    return this.createUser(organizationId, input);
  }

  async updateUser(
    organizationId: string,
    id: string,
    patch: ScimUserPatch,
    expectedVersion: number,
  ): Promise<ScimUser> {
    await this.guard(organizationId);
    validateUserPatch(patch);
    const current = await this.requireUser(organizationId, id);
    assertVersion(current.meta.version, expectedVersion);
    const userName =
      patch.userName === undefined ? current.userName : validateUserName(patch.userName);
    if (patch.userName !== undefined && patch.userName !== current.userName)
      await this.assertUserNameAvailable(organizationId, userName, current.id);
    const timestamp = this.now();
    const updated: ScimUser = {
      ...current,
      userName,
      ...(patch.displayName === undefined
        ? {}
        : { displayName: validateDisplayName(patch.displayName) }),
      ...(patch.active === undefined ? {} : { active: patch.active }),
      ...(patch.name === undefined ? {} : { name: validateName(patch.name) }),
      ...(patch.emails === undefined ? {} : { emails: validateEmails(patch.emails) }),
      meta: bumpMeta(current.meta, timestamp),
    };
    await this.store.updateUser(updated, current.meta.version);
    await this.record(organizationId, 'USER_UPDATED', 'User', updated);
    return updated;
  }

  deactivateUser(organizationId: string, id: string, expectedVersion: number): Promise<ScimUser> {
    return this.updateUser(organizationId, id, { active: false }, expectedVersion);
  }

  reactivateUser(organizationId: string, id: string, expectedVersion: number): Promise<ScimUser> {
    return this.updateUser(organizationId, id, { active: true }, expectedVersion);
  }

  async deleteUser(organizationId: string, id: string, expectedVersion: number): Promise<void> {
    await this.guard(organizationId);
    const current = await this.requireUser(organizationId, id);
    assertVersion(current.meta.version, expectedVersion);
    await this.store.deleteUser(organizationId, id, current.meta.version);
    await this.record(organizationId, 'USER_DELETED', 'User', current);
  }

  getUser(organizationId: string, id: string): Promise<ScimUser | undefined> {
    return this.store.findUser(organizationId, id);
  }

  async listUsers(
    organizationId: string,
    startIndex = 1,
    count = DEFAULT_COUNT,
  ): Promise<ScimListResponse<ScimUser>> {
    const normalized = normalizePagination(startIndex, count);
    const page = await this.store.listUsers(
      organizationId,
      normalized.startIndex,
      normalized.count,
    );
    return {
      schemas: [SCIM_SCHEMAS.listResponse],
      totalResults: page.totalResults,
      startIndex: page.startIndex,
      itemsPerPage: page.itemsPerPage,
      Resources: page.users,
    };
  }

  async createGroup(organizationId: string, input: ScimGroupInput): Promise<ScimGroup> {
    await this.guard(organizationId);
    const validated = validateGroupInput(input);
    await this.assertGroupUniqueness(organizationId, validated);
    await this.assertMembersExist(organizationId, validated.members);
    const timestamp = this.now();
    const id = uuidV7(timestamp.getTime());
    const group: ScimGroup = {
      id,
      organizationId,
      displayName: validated.displayName,
      ...(validated.externalId === undefined ? {} : { externalId: validated.externalId }),
      ...(validated.members === undefined || validated.members.length === 0
        ? {}
        : { members: validated.members }),
      meta: meta('Group', groupLocation(id), timestamp, 1),
    };
    await this.store.insertGroup(group);
    await this.record(organizationId, 'GROUP_CREATED', 'Group', group);
    return group;
  }

  async upsertGroup(organizationId: string, input: ScimGroupInput): Promise<ScimGroup> {
    if (input.externalId !== undefined) {
      const existing = await this.store.findGroupByExternalId(organizationId, input.externalId);
      if (existing !== undefined) return existing;
    }
    return this.createGroup(organizationId, input);
  }

  async updateGroup(
    organizationId: string,
    id: string,
    patch: ScimGroupPatch,
    expectedVersion: number,
  ): Promise<ScimGroup> {
    await this.guard(organizationId);
    validateGroupPatch(patch);
    const current = await this.requireGroup(organizationId, id);
    assertVersion(current.meta.version, expectedVersion);
    const displayName =
      patch.displayName === undefined
        ? current.displayName
        : validateDisplayName(patch.displayName);
    if (patch.displayName !== undefined && patch.displayName !== current.displayName)
      await this.assertGroupNameAvailable(organizationId, displayName, current.id);
    const timestamp = this.now();
    const updated: ScimGroup = {
      ...current,
      displayName,
      ...(patch.externalId === undefined
        ? {}
        : { externalId: validateExternalId(patch.externalId) }),
      meta: bumpMeta(current.meta, timestamp),
    };
    await this.store.updateGroup(updated, current.meta.version);
    await this.record(organizationId, 'GROUP_UPDATED', 'Group', updated);
    return updated;
  }

  async deleteGroup(organizationId: string, id: string, expectedVersion: number): Promise<void> {
    await this.guard(organizationId);
    const current = await this.requireGroup(organizationId, id);
    assertVersion(current.meta.version, expectedVersion);
    await this.store.deleteGroup(organizationId, id, current.meta.version);
    await this.record(organizationId, 'GROUP_DELETED', 'Group', current);
  }

  async addGroupMember(
    organizationId: string,
    groupId: string,
    userId: string,
    expectedVersion: number,
  ): Promise<ScimGroup> {
    await this.guard(organizationId);
    const group = await this.requireGroup(organizationId, groupId);
    assertVersion(group.meta.version, expectedVersion);
    await this.requireUser(organizationId, userId);
    if ((group.members ?? []).some((member) => member.value === userId)) return group;
    const timestamp = this.now();
    const updated: ScimGroup = {
      ...group,
      members: [...(group.members ?? []), { value: userId }],
      meta: bumpMeta(group.meta, timestamp),
    };
    await this.store.updateGroup(updated, group.meta.version);
    await this.record(organizationId, 'GROUP_MEMBER_ADDED', 'Group', updated);
    return updated;
  }

  async removeGroupMember(
    organizationId: string,
    groupId: string,
    userId: string,
    expectedVersion: number,
  ): Promise<ScimGroup> {
    await this.guard(organizationId);
    const group = await this.requireGroup(organizationId, groupId);
    assertVersion(group.meta.version, expectedVersion);
    const remaining = (group.members ?? []).filter((member) => member.value !== userId);
    if (remaining.length === (group.members ?? []).length) return group;
    const timestamp = this.now();
    const updated: ScimGroup = {
      ...group,
      ...(remaining.length === 0 ? {} : { members: remaining }),
      meta: bumpMeta(group.meta, timestamp),
    };
    await this.store.updateGroup(updated, group.meta.version);
    await this.record(organizationId, 'GROUP_MEMBER_REMOVED', 'Group', updated);
    return updated;
  }

  getGroup(organizationId: string, id: string): Promise<ScimGroup | undefined> {
    return this.store.findGroup(organizationId, id);
  }

  async listGroups(
    organizationId: string,
    startIndex = 1,
    count = DEFAULT_COUNT,
  ): Promise<ScimListResponse<ScimGroup>> {
    const normalized = normalizePagination(startIndex, count);
    const page = await this.store.listGroups(
      organizationId,
      normalized.startIndex,
      normalized.count,
    );
    return {
      schemas: [SCIM_SCHEMAS.listResponse],
      totalResults: page.totalResults,
      startIndex: page.startIndex,
      itemsPerPage: page.itemsPerPage,
      Resources: page.groups,
    };
  }

  private async guard(organizationId: string): Promise<void> {
    if (organizationId.trim() === '') throw new ValidationError('SCIM organization is required');
    if (this.rateLimiter !== undefined && !(await this.rateLimiter.consume(organizationId)))
      throw new RateLimitError('SCIM rate limit exceeded');
  }
  private async requireUser(organizationId: string, id: string): Promise<ScimUser> {
    const user = await this.store.findUser(organizationId, id);
    if (user === undefined) throw new ScimNotFoundError('SCIM user not found');
    return user;
  }
  private async requireGroup(organizationId: string, id: string): Promise<ScimGroup> {
    const group = await this.store.findGroup(organizationId, id);
    if (group === undefined) throw new ScimNotFoundError('SCIM group not found');
    return group;
  }
  private async assertUserUniqueness(
    organizationId: string,
    validated: { readonly userName: string; readonly externalId?: string },
  ): Promise<void> {
    if (validated.externalId !== undefined) {
      const byExternal = await this.store.findUserByExternalId(
        organizationId,
        validated.externalId,
      );
      if (byExternal !== undefined)
        throw new ScimConflictError('SCIM user externalId already exists');
    }
    await this.assertUserNameAvailable(organizationId, validated.userName);
  }
  private async assertUserNameAvailable(
    organizationId: string,
    userName: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = (await this.store.scanUsers(organizationId)).find(
      (user) => user.userName === userName && user.id !== excludeId,
    );
    if (existing !== undefined) throw new ScimConflictError('SCIM user userName already exists');
  }
  private async assertGroupUniqueness(
    organizationId: string,
    validated: { readonly displayName: string; readonly externalId?: string },
  ): Promise<void> {
    if (validated.externalId !== undefined) {
      const byExternal = await this.store.findGroupByExternalId(
        organizationId,
        validated.externalId,
      );
      if (byExternal !== undefined)
        throw new ScimConflictError('SCIM group externalId already exists');
    }
    await this.assertGroupNameAvailable(organizationId, validated.displayName);
  }
  private async assertGroupNameAvailable(
    organizationId: string,
    displayName: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = (await this.store.scanGroups(organizationId)).find(
      (group) => group.displayName === displayName && group.id !== excludeId,
    );
    if (existing !== undefined)
      throw new ScimConflictError('SCIM group displayName already exists');
  }
  private async assertMembersExist(
    organizationId: string,
    members: readonly ScimGroupMember[] | undefined,
  ): Promise<void> {
    for (const member of members ?? []) {
      if ((await this.store.findUser(organizationId, member.value)) === undefined)
        throw new ValidationError('SCIM group member user not found');
    }
  }
  private async record(
    organizationId: string,
    action: ScimAuditAction,
    resourceType: ScimResourceType,
    resource: ScimUser | ScimGroup,
  ): Promise<void> {
    await this.audit?.record({
      organizationId,
      action,
      resourceType,
      resourceId: resource.id,
      ...(resource.externalId === undefined ? {} : { externalId: resource.externalId }),
      version: resource.meta.version,
    });
  }
}

// --- Validation helpers --------------------------------------------------------

function validateUserInput(input: ScimUserInput): {
  readonly userName: string;
  readonly displayName: string;
  readonly active?: boolean;
  readonly externalId?: string;
  readonly name?: ScimUserName;
  readonly emails?: readonly ScimEmail[];
} {
  if (input.userName === undefined || input.displayName === undefined)
    throw new ValidationError('SCIM userName and displayName are required');
  return {
    userName: validateUserName(input.userName),
    displayName: validateDisplayName(input.displayName),
    ...(input.active === undefined ? {} : { active: input.active }),
    ...(input.externalId === undefined ? {} : { externalId: validateExternalId(input.externalId) }),
    ...(input.name === undefined ? {} : { name: validateName(input.name) }),
    ...(input.emails === undefined ? {} : { emails: validateEmails(input.emails) }),
  };
}

function validateUserPatch(patch: ScimUserPatch): void {
  if (
    patch.userName === undefined &&
    patch.displayName === undefined &&
    patch.active === undefined &&
    patch.name === undefined &&
    patch.emails === undefined
  )
    throw new ValidationError('SCIM user patch is empty');
  if (patch.userName !== undefined) validateUserName(patch.userName);
  if (patch.displayName !== undefined) validateDisplayName(patch.displayName);
  if (patch.name !== undefined) validateName(patch.name);
  if (patch.emails !== undefined) validateEmails(patch.emails);
}

function validateGroupInput(input: ScimGroupInput): {
  readonly displayName: string;
  readonly externalId?: string;
  readonly members?: readonly ScimGroupMember[];
} {
  if (input.displayName === undefined)
    throw new ValidationError('SCIM group displayName is required');
  return {
    displayName: validateDisplayName(input.displayName),
    ...(input.externalId === undefined ? {} : { externalId: validateExternalId(input.externalId) }),
    ...(input.members === undefined ? {} : { members: validateMembers(input.members) }),
  };
}

function validateGroupPatch(patch: ScimGroupPatch): void {
  if (patch.displayName === undefined && patch.externalId === undefined)
    throw new ValidationError('SCIM group patch is empty');
  if (patch.displayName !== undefined) validateDisplayName(patch.displayName);
  if (patch.externalId !== undefined) validateExternalId(patch.externalId);
}

function validateMembers(members: readonly ScimGroupMember[]): readonly ScimGroupMember[] {
  if (members.length === 0) return [];
  return members.map((member) => {
    if (member.value.trim() === '')
      throw new ValidationError('SCIM group member value is required');
    return {
      value: member.value,
      ...(member.display === undefined ? {} : { display: member.display }),
    };
  });
}

function validateUserName(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 128)
    throw new ValidationError('SCIM userName must contain 1-128 characters');
  return normalized;
}

function validateDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 256)
    throw new ValidationError('SCIM displayName must contain 1-256 characters');
  return normalized;
}

function validateExternalId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 256)
    throw new ValidationError('SCIM externalId must contain 1-256 characters');
  return normalized;
}

function validateName(name: ScimUserName): ScimUserName {
  for (const value of [name.formatted, name.givenName, name.familyName]) {
    if (value !== undefined && value.length > 256)
      throw new ValidationError('SCIM name fields must be at most 256 characters');
  }
  return {
    ...(name.formatted === undefined ? {} : { formatted: name.formatted }),
    ...(name.givenName === undefined ? {} : { givenName: name.givenName }),
    ...(name.familyName === undefined ? {} : { familyName: name.familyName }),
  };
}

function validateEmails(emails: readonly ScimEmail[]): readonly ScimEmail[] {
  return emails.map((email) => {
    const value = email.value.trim();
    const at = value.indexOf('@');
    if (value.length < 3 || value.length > 254 || at <= 0 || at === value.length - 1)
      throw new ValidationError('SCIM email value is invalid');
    return {
      value,
      ...(email.primary === undefined ? {} : { primary: email.primary }),
      ...(email.type === undefined ? {} : { type: email.type }),
    };
  });
}

function normalizePagination(
  startIndex: number,
  count: number,
): { startIndex: number; count: number } {
  if (!Number.isInteger(startIndex) || startIndex < 1)
    throw new ValidationError('SCIM startIndex must be a positive integer');
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT)
    throw new ValidationError(`SCIM count must be an integer between 1 and ${String(MAX_COUNT)}`);
  return { startIndex, count };
}

function assertVersion(current: number, expected: number): void {
  if (current !== expected) throw new ScimConflictError('SCIM version conflict');
}

function meta(
  resourceType: ScimResourceType,
  location: string,
  timestamp: Date,
  version: number,
): ScimMeta {
  return { resourceType, created: timestamp, lastModified: timestamp, version, location };
}

function bumpMeta(current: ScimMeta, timestamp: Date): ScimMeta {
  return { ...current, lastModified: timestamp, version: current.version + 1 };
}

function userLocation(id: string): string {
  return `/scim/v2/Users/${id}`;
}

function groupLocation(id: string): string {
  return `/scim/v2/Groups/${id}`;
}

// --- Dedicated SCIM bearer credentials ---------------------------------------

export interface ScimCredential {
  readonly organizationId: string;
  readonly keyId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface ScimCredentialStore {
  find(organizationId: string): Promise<ScimCredential | undefined>;
  upsert(credential: ScimCredential, expectedVersion?: number): Promise<ScimCredential>;
  delete(organizationId: string): Promise<void>;
}

export class InMemoryScimCredentialStore implements ScimCredentialStore {
  private readonly credentials = new Map<string, ScimCredential>();

  find(organizationId: string): Promise<ScimCredential | undefined> {
    return Promise.resolve(this.credentials.get(organizationId));
  }
  upsert(credential: ScimCredential, expectedVersion?: number): Promise<ScimCredential> {
    const current = this.credentials.get(credential.organizationId);
    if (
      current !== undefined &&
      expectedVersion !== undefined &&
      current.version !== expectedVersion
    )
      throw new ScimConflictError('SCIM credential version conflict');
    const stored = { ...credential, version: (current?.version ?? 0) + 1 };
    this.credentials.set(credential.organizationId, stored);
    return Promise.resolve(stored);
  }
  delete(organizationId: string): Promise<void> {
    this.credentials.delete(organizationId);
    return Promise.resolve();
  }
}

const credentialRecordId = 'default';

interface ScimCredentialEntity extends TenantEntity {
  readonly credential: ScimCredential;
}

export class RepositoryScimCredentialStore implements ScimCredentialStore {
  private readonly repository: Repository<ScimCredentialEntity>;
  constructor(repositoryFactory: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.repository = repositoryFactory<ScimCredentialEntity>(repositoryName('scim-credentials'));
  }
  find(organizationId: string): Promise<ScimCredential | undefined> {
    return this.repository
      .findById(organizationId, credentialRecordId)
      .then((entity) => entity?.credential);
  }
  async upsert(credential: ScimCredential, expectedVersion?: number): Promise<ScimCredential> {
    const existing = await this.repository.findById(credential.organizationId, credentialRecordId);
    if (existing === undefined) {
      const timestamp = new Date();
      await this.repository.insert({
        id: credentialRecordId,
        tenantId: credential.organizationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        credential,
      });
      return { ...credential, version: 1 };
    }
    if (expectedVersion !== undefined && existing.version !== expectedVersion)
      throw new ScimConflictError('SCIM credential version conflict');
    const version = existing.version + 1;
    await this.repository.update(
      { ...existing, version, updatedAt: new Date(), credential },
      existing.version,
    );
    return { ...credential, version };
  }
  delete(organizationId: string): Promise<void> {
    return this.repository.findById(organizationId, credentialRecordId).then(async (entity) => {
      if (entity !== undefined)
        await this.repository.delete(organizationId, credentialRecordId, entity.version);
    });
  }
}

function encodeScimOrganization(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeScimOrganization(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

const scimTokenPattern = /^hs_scim_([A-Za-z0-9_-]+)\.([0-9a-f-]+)\.([A-Za-z0-9_-]+)$/;

/**
 * Issues and verifies one dedicated SCIM bearer token per organization. The token
 * self-describes its organization so authentication remains a tenant-scoped lookup;
 * only the keyed HMAC-SHA256 digest of the secret part is stored and the raw token
 * is returned exactly once.
 */
export class ScimCredentialService {
  constructor(
    private readonly store: ScimCredentialStore,
    private readonly pepper: string,
  ) {
    if (pepper.length < 16) throw new ValidationError('SCIM credential pepper is too short');
  }

  async issue(organizationId: string): Promise<{ readonly token: string; readonly keyId: string }> {
    if (organizationId.trim() === '') throw new ValidationError('SCIM organization is required');
    const secretPart = randomBytes(32).toString('base64url');
    const keyId = uuidV7(new Date().getTime());
    const timestamp = new Date();
    const current = await this.store.find(organizationId);
    const credential: ScimCredential = {
      organizationId,
      keyId,
      tokenHash: this.hash(secretPart),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
      version: (current?.version ?? 0) + 1,
    };
    await this.store.upsert(credential, current?.version);
    return {
      token: `hs_scim_${encodeScimOrganization(organizationId)}.${keyId}.${secretPart}`,
      keyId,
    };
  }

  async authenticate(token: string): Promise<string | undefined> {
    const match = scimTokenPattern.exec(token);
    if (match === null) return undefined;
    const organizationId = decodeScimOrganization(match[1] ?? '');
    const keyId = match[2] ?? '';
    const secretPart = match[3] ?? '';
    const credential = await this.store.find(organizationId);
    if (credential?.keyId !== keyId) return undefined;
    return this.equal(this.hash(secretPart), credential.tokenHash) ? organizationId : undefined;
  }

  async revoke(organizationId: string): Promise<void> {
    await this.store.delete(organizationId);
  }

  hasCredential(organizationId: string): Promise<boolean> {
    return this.store.find(organizationId).then((credential) => credential !== undefined);
  }

  credentialKeyId(organizationId: string): Promise<string | undefined> {
    return this.store.find(organizationId).then((credential) => credential?.keyId);
  }

  private hash(secretPart: string): string {
    return createHmac('sha256', this.pepper).update(secretPart).digest('base64url');
  }

  private equal(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}
