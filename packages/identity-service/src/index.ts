import { uuidV7 } from '@handstack/domain';
import {
  normalizeUsername,
  type Group,
  type GroupMembership,
  type IdentityAuditEvent,
  type IdentityAuditEventType,
  type IdentityProvider,
  type IdentityMapping,
  type Organization,
  type OrganizationMembership,
  type OrganizationLoginPolicy,
  type OrganizationOwnedEntity,
  type Principal,
  type User,
} from '@handstack/identity';
import type {
  IdentityStorage,
  OrganizationStores,
  ScopedRepository,
} from '@handstack/identity-storage';
import {
  parsePermission,
  type AuthorizationDecision,
  type Permission,
  type PrincipalRole,
  type Role,
  type RolePermission,
} from '@handstack/policy';
import { AuthorizationError } from '@handstack/shared';

interface EntityInput {
  readonly id?: string;
}

interface UserInput extends EntityInput {
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
}

interface GroupInput extends EntityInput {
  readonly name: string;
  readonly description?: string;
}

interface RoleInput extends EntityInput {
  readonly name: string;
  readonly description?: string;
}

interface UserUpdate {
  readonly displayName?: string;
  readonly email?: string;
}

interface GroupUpdate {
  readonly name?: string;
  readonly description?: string;
}

interface RoleUpdate {
  readonly name?: string;
  readonly description?: string;
}

function base(organizationId: string, id = uuidV7(), timestamp = new Date()) {
  return {
    id,
    tenantId: organizationId,
    organizationId,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function all<T extends OrganizationOwnedEntity>(
  repository: ScopedRepository<T>,
): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    result.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return result;
}

function duplicate(kind: string, value: string): never {
  throw new Error(`${kind} already exists: ${value}`);
}

export class IdentityAdministrationService {
  constructor(private readonly storage: IdentityStorage) {}

  listUsers(organizationId: string): Promise<User[]> {
    return all(this.storage.forOrganization(organizationId).users);
  }

  listGroups(organizationId: string): Promise<Group[]> {
    return all(this.storage.forOrganization(organizationId).groups);
  }

  listRoles(organizationId: string): Promise<Role[]> {
    return all(this.storage.forOrganization(organizationId).roles);
  }

  listGroupMemberships(organizationId: string): Promise<GroupMembership[]> {
    return all(this.storage.forOrganization(organizationId).groupMemberships);
  }

  listPrincipalRoles(organizationId: string): Promise<PrincipalRole[]> {
    return all(this.storage.forOrganization(organizationId).principalRoles);
  }

  listPermissions(organizationId: string): Promise<Permission[]> {
    return all(this.storage.forOrganization(organizationId).permissions);
  }

  listRolePermissions(organizationId: string): Promise<RolePermission[]> {
    return all(this.storage.forOrganization(organizationId).rolePermissions);
  }

  async listPrincipalPermissions(organizationId: string, principalId: string): Promise<string[]> {
    const stores = this.storage.forOrganization(organizationId);
    const roleIds = new Set(
      (await all(stores.principalRoles))
        .filter((item) => item.principalId === principalId)
        .map((item) => item.roleId),
    );
    const permissionIds = new Set(
      (await all(stores.rolePermissions))
        .filter((item) => roleIds.has(item.roleId))
        .map((item) => item.permissionId),
    );
    return (await all(stores.permissions))
      .filter((permission) => permissionIds.has(permission.id))
      .map((permission) => `${permission.resource}.${permission.action}`)
      .sort();
  }

  async updateUser(organizationId: string, userId: string, input: UserUpdate): Promise<User> {
    return this.storage.run(organizationId, async (stores) => {
      const current = await stores.users.findById(userId);
      const principal = await stores.principals.findById(userId);
      if (current === undefined || principal === undefined) throw new Error('User not found');
      const timestamp = new Date();
      const displayName = input.displayName?.trim() ?? current.displayName;
      const updatedPrincipal: Principal = {
        ...principal,
        displayName,
        version: principal.version + 1,
        updatedAt: timestamp,
      };
      const updated: User = {
        ...current,
        displayName,
        ...(input.email === undefined ? {} : { email: input.email.trim().toLowerCase() }),
        version: current.version + 1,
        updatedAt: timestamp,
      };
      await stores.principals.update(updatedPrincipal, principal.version);
      return stores.users.update(updated, current.version);
    });
  }

  async updateGroup(organizationId: string, groupId: string, input: GroupUpdate): Promise<Group> {
    return this.storage.run(organizationId, async (stores) => {
      const current = await stores.groups.findById(groupId);
      if (current === undefined) throw new Error('Group not found');
      const name = input.name?.trim() ?? current.name;
      const duplicateName = (await all(stores.groups)).some(
        (item) => item.id !== groupId && item.name === name,
      );
      if (duplicateName) duplicate('group', name);
      return stores.groups.update(
        {
          ...current,
          name,
          ...(input.description === undefined ? {} : { description: input.description.trim() }),
          version: current.version + 1,
          updatedAt: new Date(),
        },
        current.version,
      );
    });
  }

  async updateRole(organizationId: string, roleId: string, input: RoleUpdate): Promise<Role> {
    return this.storage.run(organizationId, async (stores) => {
      const current = await stores.roles.findById(roleId);
      if (current === undefined) throw new Error('Role not found');
      const name = input.name?.trim() ?? current.name;
      const duplicateName = (await all(stores.roles)).some(
        (item) => item.id !== roleId && item.name === name,
      );
      if (duplicateName) duplicate('role', name);
      return stores.roles.update(
        {
          ...current,
          name,
          ...(input.description === undefined ? {} : { description: input.description.trim() }),
          version: current.version + 1,
          updatedAt: new Date(),
        },
        current.version,
      );
    });
  }

  async createOrganization(input: {
    readonly id?: string;
    readonly name: string;
    readonly slug: string;
  }): Promise<Organization> {
    const id = input.id ?? uuidV7();
    const timestamp = new Date();
    return this.storage.organizations.insert({
      id,
      tenantId: id,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      name: input.name.trim(),
      slug: input.slug.trim().toLowerCase(),
      status: 'ACTIVE',
    });
  }

  createUser(organizationId: string, input: UserInput): Promise<User> {
    return this.storage.run(organizationId, async (stores) => {
      const normalizedUsername = normalizeUsername(input.username);
      if (
        (await all(stores.users)).some((user) => user.normalizedUsername === normalizedUsername)
      ) {
        duplicate('username', normalizedUsername);
      }
      const identity = base(organizationId, input.id);
      const principal: Principal = {
        ...identity,
        type: 'USER',
        status: 'ACTIVE',
        displayName: input.displayName.trim(),
      };
      const user: User = {
        ...principal,
        type: 'USER',
        username: input.username.trim(),
        normalizedUsername,
        ...(input.email === undefined ? {} : { email: input.email.trim().toLowerCase() }),
      };
      const membership: OrganizationMembership = {
        ...base(organizationId),
        userId: user.id,
        status: 'ACTIVE',
      };
      await stores.principals.insert(principal);
      await stores.users.insert(user);
      await stores.organizationMemberships.insert(membership);
      return user;
    });
  }

  createGroup(organizationId: string, input: GroupInput): Promise<Group> {
    return this.storage.run(organizationId, async (stores) => {
      const name = input.name.trim();
      if ((await all(stores.groups)).some((group) => group.name === name)) duplicate('group', name);
      return stores.groups.insert({
        ...base(organizationId, input.id),
        name,
        ...(input.description === undefined ? {} : { description: input.description.trim() }),
      });
    });
  }

  addPrincipalToGroup(
    organizationId: string,
    groupId: string,
    principalId: string,
  ): Promise<GroupMembership> {
    return this.storage.run(organizationId, async (stores) => {
      if ((await stores.groups.findById(groupId)) === undefined) throw new Error('Group not found');
      if ((await stores.principals.findById(principalId)) === undefined) {
        throw new Error('Principal not found');
      }
      const existing = (await all(stores.groupMemberships)).find(
        (item) => item.groupId === groupId && item.principalId === principalId,
      );
      if (existing !== undefined) return existing;
      return stores.groupMemberships.insert({
        ...base(organizationId),
        groupId,
        principalId,
      });
    });
  }

  async removePrincipalFromGroup(
    organizationId: string,
    groupId: string,
    principalId: string,
  ): Promise<boolean> {
    return this.storage.run(organizationId, async (stores) => {
      const existing = (await all(stores.groupMemberships)).find(
        (item) => item.groupId === groupId && item.principalId === principalId,
      );
      if (existing === undefined) return false;
      await stores.groupMemberships.delete(existing.id, existing.version);
      return true;
    });
  }

  createRole(organizationId: string, input: RoleInput): Promise<Role> {
    return this.storage.run(organizationId, async (stores) => {
      const name = input.name.trim();
      if ((await all(stores.roles)).some((role) => role.name === name)) duplicate('role', name);
      return stores.roles.insert({
        ...base(organizationId, input.id),
        name,
        ...(input.description === undefined ? {} : { description: input.description.trim() }),
      });
    });
  }

  createPermission(organizationId: string, value: string, id?: string): Promise<Permission> {
    return this.storage.run(organizationId, async (stores) => {
      const parsed = parsePermission(value);
      if (
        (await all(stores.permissions)).some(
          (permission) =>
            permission.resource === parsed.resource && permission.action === parsed.action,
        )
      ) {
        duplicate('permission', value);
      }
      return stores.permissions.insert({ ...base(organizationId, id), ...parsed });
    });
  }

  grantPermission(
    organizationId: string,
    roleId: string,
    permissionId: string,
  ): Promise<RolePermission> {
    return this.storage.run(organizationId, async (stores) => {
      await this.requireReferences(stores, roleId, permissionId);
      const existing = (await all(stores.rolePermissions)).find(
        (item) => item.roleId === roleId && item.permissionId === permissionId,
      );
      if (existing !== undefined) return existing;
      return stores.rolePermissions.insert({
        ...base(organizationId),
        roleId,
        permissionId,
      });
    });
  }

  assignRole(organizationId: string, principalId: string, roleId: string): Promise<PrincipalRole> {
    return this.storage.run(organizationId, async (stores) => {
      if ((await stores.principals.findById(principalId)) === undefined) {
        throw new Error('Principal not found');
      }
      if ((await stores.roles.findById(roleId)) === undefined) throw new Error('Role not found');
      const existing = (await all(stores.principalRoles)).find(
        (item) => item.principalId === principalId && item.roleId === roleId,
      );
      if (existing !== undefined) return existing;
      return stores.principalRoles.insert({ ...base(organizationId), principalId, roleId });
    });
  }

  async unassignRole(
    organizationId: string,
    principalId: string,
    roleId: string,
  ): Promise<boolean> {
    return this.storage.run(organizationId, async (stores) => {
      const existing = (await all(stores.principalRoles)).find(
        (item) => item.principalId === principalId && item.roleId === roleId,
      );
      if (existing === undefined) return false;
      await stores.principalRoles.delete(existing.id, existing.version);
      return true;
    });
  }

  async revokePermission(
    organizationId: string,
    roleId: string,
    permissionId: string,
  ): Promise<boolean> {
    return this.storage.run(organizationId, async (stores) => {
      const existing = (await all(stores.rolePermissions)).find(
        (item) => item.roleId === roleId && item.permissionId === permissionId,
      );
      if (existing === undefined) return false;
      await stores.rolePermissions.delete(existing.id, existing.version);
      return true;
    });
  }

  async authorize(input: {
    readonly organizationId: string;
    readonly principalId: string;
    readonly permission: string;
  }): Promise<AuthorizationDecision> {
    const stores = this.storage.forOrganization(input.organizationId);
    if ((await stores.principals.findById(input.principalId)) === undefined) {
      return { allowed: false, reason: 'principal not found' };
    }
    const requested = parsePermission(input.permission);
    const principalRoleIds = new Set(
      (await all(stores.principalRoles))
        .filter((item) => item.principalId === input.principalId)
        .map((item) => item.roleId),
    );
    const permissionIds = new Set(
      (await all(stores.rolePermissions))
        .filter((item) => principalRoleIds.has(item.roleId))
        .map((item) => item.permissionId),
    );
    const matched = (await all(stores.permissions)).find(
      (permission) =>
        permissionIds.has(permission.id) &&
        permission.resource === requested.resource &&
        permission.action === requested.action,
    );
    return matched === undefined
      ? { allowed: false, reason: 'permission not granted' }
      : { allowed: true, policyIds: [...principalRoleIds] };
  }

  deprovisionUser(
    organizationId: string,
    userId: string,
  ): Promise<{ readonly sessionsRevoked: number; readonly apiKeysRevoked: number }> {
    return this.storage.run(organizationId, async (stores) => {
      const [user, principal] = await Promise.all([
        stores.users.findById(userId),
        stores.principals.findById(userId),
      ]);
      if (user === undefined || principal === undefined) throw new Error('User not found');
      const timestamp = new Date();
      const activeSessions = (await all(stores.sessions)).filter(
        (session) => session.principalId === userId && session.revokedAt === undefined,
      );
      const activeApiKeys = (await all(stores.apiKeys)).filter(
        (apiKey) => apiKey.principalId === userId && apiKey.revokedAt === undefined,
      );
      if (user.status !== 'DISABLED') {
        await stores.users.update(
          { ...user, status: 'DISABLED', version: user.version + 1, updatedAt: timestamp },
          user.version,
        );
      }
      if (principal.status !== 'DISABLED') {
        await stores.principals.update(
          {
            ...principal,
            status: 'DISABLED',
            version: principal.version + 1,
            updatedAt: timestamp,
          },
          principal.version,
        );
      }
      for (const membership of (await all(stores.organizationMemberships)).filter(
        (item) => item.userId === userId && item.status !== 'DISABLED',
      )) {
        await stores.organizationMemberships.update(
          {
            ...membership,
            status: 'DISABLED',
            version: membership.version + 1,
            updatedAt: timestamp,
          },
          membership.version,
        );
      }
      for (const session of activeSessions) {
        await stores.sessions.update(
          { ...session, revokedAt: timestamp, version: session.version + 1, updatedAt: timestamp },
          session.version,
        );
      }
      for (const apiKey of activeApiKeys) {
        await stores.apiKeys.update(
          { ...apiKey, revokedAt: timestamp, version: apiKey.version + 1, updatedAt: timestamp },
          apiKey.version,
        );
      }
      const breakGlass = await stores.breakGlassAccounts.findById(userId);
      if (breakGlass?.enabled === true) {
        await stores.breakGlassAccounts.update(
          {
            ...breakGlass,
            enabled: false,
            version: breakGlass.version + 1,
            updatedAt: timestamp,
          },
          breakGlass.version,
        );
      }
      if (user.status !== 'DISABLED') {
        await stores.auditEvents.insert(
          auditEntity(organizationId, {
            eventType: 'USER_DEPROVISIONED',
            principalId: userId,
            details: {
              sessionsRevoked: activeSessions.length,
              apiKeysRevoked: activeApiKeys.length,
            },
          }),
        );
      }
      return { sessionsRevoked: activeSessions.length, apiKeysRevoked: activeApiKeys.length };
    });
  }

  private async requireReferences(
    stores: OrganizationStores,
    roleId: string,
    permissionId: string,
  ): Promise<void> {
    if ((await stores.roles.findById(roleId)) === undefined) throw new Error('Role not found');
    if ((await stores.permissions.findById(permissionId)) === undefined) {
      throw new Error('Permission not found');
    }
  }
}

export interface IdentityProviderInput {
  readonly id?: string;
  readonly pluginId: string;
  readonly name: string;
  readonly slug: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly configuration: IdentityProvider['configuration'];
  readonly clientSecretReference?: string;
  readonly loginPolicy?: IdentityProvider['loginPolicy'];
  readonly provisioningPolicy?: IdentityProvider['provisioningPolicy'];
  readonly mappingPolicy?: IdentityProvider['mappingPolicy'];
}

export interface IdentityMappingInput {
  readonly sourceClaim: string;
  readonly sourceValue: string;
  readonly targetType: IdentityMapping['targetType'];
  readonly targetId: string;
  readonly enabled?: boolean;
}

function auditEntity(
  organizationId: string,
  input: {
    readonly eventType: IdentityAuditEventType;
    readonly outcome?: IdentityAuditEvent['outcome'];
    readonly principalId?: string;
    readonly providerId?: string;
    readonly details?: IdentityAuditEvent['details'];
  },
): IdentityAuditEvent {
  return {
    ...base(organizationId),
    eventType: input.eventType,
    outcome: input.outcome ?? 'SUCCESS',
    ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
    ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
    details: input.details ?? {},
  };
}

export class IdentityAuditService {
  constructor(private readonly storage: IdentityStorage) {}

  record(
    organizationId: string,
    input: Parameters<typeof auditEntity>[1],
  ): Promise<IdentityAuditEvent> {
    return this.storage
      .forOrganization(organizationId)
      .auditEvents.insert(auditEntity(organizationId, input));
  }
}

function assertPublicConfiguration(configuration: IdentityProvider['configuration']): void {
  const issuer = new URL(configuration.issuer);
  const redirect = new URL(configuration.redirectUri);
  if (issuer.protocol !== 'https:' || redirect.protocol !== 'https:') {
    throw new TypeError('OIDC issuer and redirect URI must use HTTPS');
  }
  if (configuration.clientId.trim().length === 0) throw new TypeError('clientId is required');
  if (!configuration.scopes.includes('openid'))
    throw new TypeError('OIDC scopes must include openid');
  const serialized = JSON.stringify(configuration);
  if (/client.?secret|password|private.?key|access.?token/i.test(serialized)) {
    throw new TypeError('Identity provider configuration contains secret material');
  }
}

function claim(claims: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function usernameCandidate(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 128);
  return normalized.length >= 3 ? normalized : `user-${normalized.padEnd(3, '0')}`;
}

export class IdentityProviderAdministrationService {
  constructor(private readonly storage: IdentityStorage) {}

  create(organizationId: string, input: IdentityProviderInput): Promise<IdentityProvider> {
    assertPublicConfiguration(input.configuration);
    return this.storage.run(organizationId, async (stores) => {
      const slug = input.slug.trim().toLocaleLowerCase('en-US');
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
        throw new TypeError('Identity provider slug is invalid');
      }
      if ((await all(stores.identityProviders)).some((provider) => provider.slug === slug)) {
        duplicate('identity provider slug', slug);
      }
      const timestamp = new Date();
      const provider: IdentityProvider = {
        ...base(organizationId, input.id, timestamp),
        pluginId: input.pluginId,
        name: input.name.trim(),
        slug,
        type: 'OIDC',
        enabled: input.enabled ?? true,
        priority: input.priority ?? 100,
        configuration: {
          issuer: input.configuration.issuer,
          clientId: input.configuration.clientId,
          redirectUri: input.configuration.redirectUri,
          scopes: [...input.configuration.scopes],
        },
        ...(input.clientSecretReference === undefined
          ? {}
          : { clientSecretReference: input.clientSecretReference }),
        loginPolicy: input.loginPolicy ?? { accountLinking: 'DISABLED' },
        provisioningPolicy: input.provisioningPolicy ?? { jitEnabled: false },
        mappingPolicy: input.mappingPolicy ?? {
          usernameClaim: 'preferred_username',
          displayNameClaim: 'name',
          emailClaim: 'email',
        },
      };
      const inserted = await stores.identityProviders.insert(provider);
      await stores.auditEvents.insert(
        auditEntity(organizationId, {
          eventType: 'IDENTITY_PROVIDER_CREATED',
          providerId: provider.id,
          details: { slug: provider.slug, type: provider.type },
        }),
      );
      return inserted;
    });
  }

  async list(organizationId: string): Promise<IdentityProvider[]> {
    return (await all(this.storage.forOrganization(organizationId).identityProviders)).sort(
      (left, right) => left.priority - right.priority || left.slug.localeCompare(right.slug),
    );
  }

  async findEnabled(organizationId: string, slug: string): Promise<IdentityProvider> {
    const provider = (await this.list(organizationId)).find(
      (candidate) => candidate.slug === slug && candidate.enabled,
    );
    if (provider === undefined) throw new Error('Identity provider not found or disabled');
    return provider;
  }

  setEnabled(
    organizationId: string,
    providerId: string,
    enabled: boolean,
  ): Promise<IdentityProvider> {
    return this.storage.run(organizationId, async (stores) => {
      const provider = await stores.identityProviders.findById(providerId);
      if (provider === undefined) throw new Error('Identity provider not found');
      const updated = await stores.identityProviders.update(
        {
          ...provider,
          version: provider.version + 1,
          updatedAt: new Date(),
          enabled,
        },
        provider.version,
      );
      await stores.auditEvents.insert(
        auditEntity(organizationId, {
          eventType: enabled ? 'IDENTITY_PROVIDER_UPDATED' : 'IDENTITY_PROVIDER_DISABLED',
          providerId,
          details: { enabled },
        }),
      );
      return updated;
    });
  }

  setLoginPolicy(
    organizationId: string,
    input: {
      readonly mode: OrganizationLoginPolicy['mode'];
      readonly requiredProviderId?: string;
      readonly breakGlassEnabled?: boolean;
      readonly maxBreakGlassAccounts?: number;
    },
  ): Promise<OrganizationLoginPolicy> {
    return this.storage.run(organizationId, async (stores) => {
      if (input.mode === 'SPECIFIC_IDP_REQUIRED') {
        if (input.requiredProviderId === undefined) {
          throw new TypeError('requiredProviderId is required for specific IdP enforcement');
        }
        const required = await stores.identityProviders.findById(input.requiredProviderId);
        if (required?.enabled !== true)
          throw new Error('Required identity provider is unavailable');
      } else if (input.requiredProviderId !== undefined) {
        throw new TypeError('requiredProviderId is only valid for specific IdP enforcement');
      }
      const maximum = input.maxBreakGlassAccounts ?? 2;
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10) {
        throw new TypeError('maxBreakGlassAccounts must be between 1 and 10');
      }
      const existing = await stores.loginPolicies.findById(organizationId);
      const timestamp = new Date();
      const policy: OrganizationLoginPolicy = {
        ...base(organizationId, organizationId, timestamp),
        ...(existing === undefined
          ? {}
          : { version: existing.version + 1, createdAt: existing.createdAt }),
        mode: input.mode,
        ...(input.requiredProviderId === undefined
          ? {}
          : { requiredProviderId: input.requiredProviderId }),
        breakGlassEnabled: input.breakGlassEnabled ?? false,
        maxBreakGlassAccounts: maximum,
      };
      if (existing === undefined) await stores.loginPolicies.insert(policy);
      else await stores.loginPolicies.update(policy, existing.version);
      await stores.auditEvents.insert(
        auditEntity(organizationId, {
          eventType: 'LOGIN_POLICY_UPDATED',
          details: {
            mode: policy.mode,
            breakGlassEnabled: policy.breakGlassEnabled,
            maxBreakGlassAccounts: policy.maxBreakGlassAccounts,
          },
        }),
      );
      return policy;
    });
  }

  async loginPolicy(organizationId: string): Promise<OrganizationLoginPolicy> {
    return (
      (await this.storage
        .forOrganization(organizationId)
        .loginPolicies.findById(organizationId)) ?? {
        ...base(organizationId, organizationId),
        mode: 'LOCAL_ALLOWED',
        breakGlassEnabled: false,
        maxBreakGlassAccounts: 2,
      }
    );
  }

  async assertProviderAllowed(organizationId: string, providerId: string): Promise<void> {
    const policy = await this.loginPolicy(organizationId);
    if (policy.mode === 'SPECIFIC_IDP_REQUIRED' && policy.requiredProviderId !== providerId) {
      throw new AuthorizationError('Organization requires a different identity provider');
    }
  }

  setMappings(
    organizationId: string,
    providerId: string,
    inputs: readonly IdentityMappingInput[],
  ): Promise<IdentityMapping[]> {
    return this.storage.run(organizationId, async (stores) => {
      if ((await stores.identityProviders.findById(providerId)) === undefined) {
        throw new Error('Identity provider not found');
      }
      if (inputs.length > 100) throw new TypeError('At most 100 identity mappings are allowed');
      const seen = new Set<string>();
      for (const input of inputs) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(input.sourceClaim)) {
          throw new TypeError('Mapping sourceClaim is invalid');
        }
        if (input.sourceValue.length === 0 || input.sourceValue.length > 256) {
          throw new TypeError('Mapping sourceValue is invalid');
        }
        const target =
          input.targetType === 'GROUP'
            ? await stores.groups.findById(input.targetId)
            : await stores.roles.findById(input.targetId);
        if (target === undefined) throw new Error('Mapping target not found');
        const key = `${input.sourceClaim}\0${input.sourceValue}\0${input.targetType}\0${input.targetId}`;
        if (seen.has(key)) throw new TypeError('Duplicate identity mapping');
        seen.add(key);
      }
      const existing = (await all(stores.identityMappings)).filter(
        (mapping) => mapping.identityProviderId === providerId,
      );
      for (const mapping of existing)
        await stores.identityMappings.delete(mapping.id, mapping.version);
      const mappings: IdentityMapping[] = [];
      for (const input of inputs) {
        mappings.push(
          await stores.identityMappings.insert({
            ...base(organizationId),
            identityProviderId: providerId,
            sourceClaim: input.sourceClaim,
            sourceValue: input.sourceValue,
            targetType: input.targetType,
            targetId: input.targetId,
            enabled: input.enabled ?? true,
          }),
        );
      }
      await stores.auditEvents.insert(
        auditEntity(organizationId, {
          eventType: 'IDENTITY_MAPPINGS_UPDATED',
          providerId,
          details: { mappingCount: mappings.length },
        }),
      );
      return mappings;
    });
  }

  async listMappings(organizationId: string, providerId: string): Promise<IdentityMapping[]> {
    return (await all(this.storage.forOrganization(organizationId).identityMappings)).filter(
      (mapping) => mapping.identityProviderId === providerId,
    );
  }

  reconcileMappings(
    organizationId: string,
    providerId: string,
    principalId: string,
    claims: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return this.storage.run(organizationId, async (stores) => {
      const mappings = (await all(stores.identityMappings)).filter(
        (mapping) => mapping.identityProviderId === providerId && mapping.enabled,
      );
      const desired = new Map(
        mappings
          .filter((mapping) => {
            const value = claims[mapping.sourceClaim];
            return Array.isArray(value)
              ? value.some((item) => typeof item === 'string' && item === mapping.sourceValue)
              : typeof value === 'string' && value === mapping.sourceValue;
          })
          .map((mapping) => [mapping.id, mapping]),
      );
      const grants = (await all(stores.identityMappingGrants)).filter(
        (grant) => grant.identityProviderId === providerId && grant.principalId === principalId,
      );
      for (const grant of grants.filter((item) => !desired.has(item.mappingId))) {
        const repository =
          grant.targetType === 'GROUP' ? stores.groupMemberships : stores.principalRoles;
        const assignment = await repository.findById(grant.assignmentId);
        if (assignment !== undefined) await repository.delete(assignment.id, assignment.version);
        await stores.identityMappingGrants.delete(grant.id, grant.version);
      }
      let added = 0;
      for (const mapping of desired.values()) {
        if (grants.some((grant) => grant.mappingId === mapping.id)) continue;
        if (mapping.targetType === 'GROUP') {
          const manual = (await all(stores.groupMemberships)).some(
            (item) => item.groupId === mapping.targetId && item.principalId === principalId,
          );
          if (manual) continue;
          const assignment = await stores.groupMemberships.insert({
            ...base(organizationId),
            groupId: mapping.targetId,
            principalId,
          });
          await stores.identityMappingGrants.insert({
            ...base(organizationId),
            identityProviderId: providerId,
            mappingId: mapping.id,
            principalId,
            targetType: 'GROUP',
            targetId: mapping.targetId,
            assignmentId: assignment.id,
          });
        } else {
          const manual = (await all(stores.principalRoles)).some(
            (item) => item.roleId === mapping.targetId && item.principalId === principalId,
          );
          if (manual) continue;
          const assignment = await stores.principalRoles.insert({
            ...base(organizationId),
            roleId: mapping.targetId,
            principalId,
          });
          await stores.identityMappingGrants.insert({
            ...base(organizationId),
            identityProviderId: providerId,
            mappingId: mapping.id,
            principalId,
            targetType: 'ROLE',
            targetId: mapping.targetId,
            assignmentId: assignment.id,
          });
        }
        added += 1;
      }
      if (added > 0 || grants.some((item) => !desired.has(item.mappingId))) {
        await stores.auditEvents.insert(
          auditEntity(organizationId, {
            eventType: 'IDENTITY_MEMBERSHIPS_RECONCILED',
            principalId,
            providerId,
            details: {
              added,
              removed: grants.filter((item) => !desired.has(item.mappingId)).length,
            },
          }),
        );
      }
    });
  }

  async resolvePrincipal(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly subject: string;
    readonly claims: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    const stores = this.storage.forOrganization(input.organizationId);
    const provider = await stores.identityProviders.findById(input.providerId);
    if (provider?.enabled !== true) throw new Error('Identity provider is disabled');
    const existing = (await all(stores.externalIdentities)).find(
      (identity) => identity.providerId === input.providerId && identity.subject === input.subject,
    );
    if (existing !== undefined) {
      await this.reconcileMappings(
        input.organizationId,
        input.providerId,
        existing.principalId,
        input.claims,
      );
      return existing.principalId;
    }

    const email = claim(input.claims, provider.mappingPolicy.emailClaim)?.toLocaleLowerCase(
      'en-US',
    );
    if (
      provider.loginPolicy.accountLinking === 'VERIFIED_EMAIL' &&
      input.claims.email_verified === true &&
      email !== undefined
    ) {
      const linked = (await all(stores.users)).find(
        (user) => user.status === 'ACTIVE' && user.email === email,
      );
      if (linked !== undefined) {
        await this.reconcileMappings(
          input.organizationId,
          input.providerId,
          linked.id,
          input.claims,
        );
        return linked.id;
      }
    }
    if (!provider.provisioningPolicy.jitEnabled) {
      throw new Error('JIT provisioning and account linking are not permitted');
    }

    const rawUsername =
      claim(input.claims, provider.mappingPolicy.usernameClaim) ??
      email?.split('@')[0] ??
      `oidc-${input.subject}`;
    const username = usernameCandidate(rawUsername);
    const users = await all(stores.users);
    const availableUsername = users.some(
      (user) => user.normalizedUsername === normalizeUsername(username),
    )
      ? usernameCandidate(`${username}-${input.subject.slice(-8)}`)
      : username;
    const displayName =
      claim(input.claims, provider.mappingPolicy.displayNameClaim) ?? email ?? availableUsername;
    const user = await new IdentityAdministrationService(this.storage).createUser(
      input.organizationId,
      {
        username: availableUsername,
        displayName,
        ...(email === undefined ? {} : { email }),
      },
    );
    await new IdentityAuditService(this.storage).record(input.organizationId, {
      eventType: 'JIT_USER_CREATED',
      principalId: user.id,
      providerId: input.providerId,
      details: { username: user.normalizedUsername },
    });
    await this.reconcileMappings(input.organizationId, input.providerId, user.id, input.claims);
    return user.id;
  }
}
