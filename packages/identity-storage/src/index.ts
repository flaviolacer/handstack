import type {
  ApiKey,
  LocalCredential,
  OidcAuthorizationTransaction,
  Session,
} from '@handstack/auth';
import type { DatabaseAdapter } from '@handstack/database';
import {
  repositoryName,
  type Page,
  type PageRequest,
  type Repository,
  type TransactionContext,
} from '@handstack/domain';
import {
  assertOrganizationScope,
  type ExternalIdentity,
  type Group,
  type GroupMembership,
  type BreakGlassAccount,
  type IdentityAuditEvent,
  type IdentityProvider,
  type IdentityMapping,
  type IdentityMappingGrant,
  type Organization,
  type OrganizationLoginPolicy,
  type OrganizationMembership,
  type OrganizationOwnedEntity,
  type Principal,
  type User,
} from '@handstack/identity';
import type { Permission, PrincipalRole, Role, RolePermission } from '@handstack/policy';

const names = {
  organizations: repositoryName('identity-organizations'),
  principals: repositoryName('identity-principals'),
  users: repositoryName('identity-users'),
  organizationMemberships: repositoryName('identity-organization-memberships'),
  groups: repositoryName('identity-groups'),
  groupMemberships: repositoryName('identity-group-memberships'),
  externalIdentities: repositoryName('identity-external-identities'),
  identityProviders: repositoryName('identity-providers'),
  loginPolicies: repositoryName('identity-login-policies'),
  breakGlassAccounts: repositoryName('identity-break-glass-accounts'),
  identityMappings: repositoryName('identity-mappings'),
  identityMappingGrants: repositoryName('identity-mapping-grants'),
  auditEvents: repositoryName('identity-audit-events'),
  roles: repositoryName('identity-roles'),
  permissions: repositoryName('identity-permissions'),
  rolePermissions: repositoryName('identity-role-permissions'),
  principalRoles: repositoryName('identity-principal-roles'),
  credentials: repositoryName('auth-local-credentials'),
  sessions: repositoryName('auth-sessions'),
  apiKeys: repositoryName('auth-api-keys'),
  oidcTransactions: repositoryName('auth-oidc-transactions'),
} as const;

/**
 * Compatibility contract for persisted identity repository namespaces.
 * Names are append-only within a schema version because changing one would orphan data.
 */
export const identityStorageSchema = {
  version: 1,
  repositories: { ...names },
} as const;

export interface ScopedRepository<T extends OrganizationOwnedEntity> {
  findById(id: string): Promise<T | undefined>;
  list(page: PageRequest): Promise<Page<T>>;
  insert(entity: T): Promise<T>;
  update(entity: T, expectedVersion: number): Promise<T>;
  delete(id: string, expectedVersion: number): Promise<boolean>;
}

class OrganizationScopedRepository<
  T extends OrganizationOwnedEntity,
> implements ScopedRepository<T> {
  constructor(
    private readonly organizationId: string,
    private readonly repository: Repository<T>,
  ) {}

  findById(id: string): Promise<T | undefined> {
    return this.repository.findById(this.organizationId, id);
  }

  list(page: PageRequest): Promise<Page<T>> {
    return this.repository.list(this.organizationId, page);
  }

  insert(entity: T): Promise<T> {
    this.assertScope(entity);
    return this.repository.insert(entity);
  }

  update(entity: T, expectedVersion: number): Promise<T> {
    this.assertScope(entity);
    return this.repository.update(entity, expectedVersion);
  }

  delete(id: string, expectedVersion: number): Promise<boolean> {
    return this.repository.delete(this.organizationId, id, expectedVersion);
  }

  private assertScope(entity: T): void {
    assertOrganizationScope(entity);
    if (entity.organizationId !== this.organizationId) {
      throw new TypeError('Entity belongs to a different organization');
    }
  }
}

export interface OrganizationStores {
  readonly principals: ScopedRepository<Principal>;
  readonly users: ScopedRepository<User>;
  readonly organizationMemberships: ScopedRepository<OrganizationMembership>;
  readonly groups: ScopedRepository<Group>;
  readonly groupMemberships: ScopedRepository<GroupMembership>;
  readonly externalIdentities: ScopedRepository<ExternalIdentity>;
  readonly identityProviders: ScopedRepository<IdentityProvider>;
  readonly loginPolicies: ScopedRepository<OrganizationLoginPolicy>;
  readonly breakGlassAccounts: ScopedRepository<BreakGlassAccount>;
  readonly identityMappings: ScopedRepository<IdentityMapping>;
  readonly identityMappingGrants: ScopedRepository<IdentityMappingGrant>;
  readonly auditEvents: ScopedRepository<IdentityAuditEvent>;
  readonly roles: ScopedRepository<Role>;
  readonly permissions: ScopedRepository<Permission>;
  readonly rolePermissions: ScopedRepository<RolePermission>;
  readonly principalRoles: ScopedRepository<PrincipalRole>;
  readonly credentials: ScopedRepository<LocalCredential>;
  readonly sessions: ScopedRepository<Session>;
  readonly apiKeys: ScopedRepository<ApiKey>;
  readonly oidcTransactions: ScopedRepository<OidcAuthorizationTransaction>;
}

function scoped<T extends OrganizationOwnedEntity>(
  context: TransactionContext,
  organizationId: string,
  name: (typeof names)[keyof typeof names],
): ScopedRepository<T> {
  return new OrganizationScopedRepository(organizationId, context.repository<T>(name));
}

function organizationStores(
  context: TransactionContext,
  organizationId: string,
): OrganizationStores {
  if (organizationId.length === 0) throw new TypeError('organizationId is required');
  return {
    principals: scoped(context, organizationId, names.principals),
    users: scoped(context, organizationId, names.users),
    organizationMemberships: scoped(context, organizationId, names.organizationMemberships),
    groups: scoped(context, organizationId, names.groups),
    groupMemberships: scoped(context, organizationId, names.groupMemberships),
    externalIdentities: scoped(context, organizationId, names.externalIdentities),
    identityProviders: scoped(context, organizationId, names.identityProviders),
    loginPolicies: scoped(context, organizationId, names.loginPolicies),
    breakGlassAccounts: scoped(context, organizationId, names.breakGlassAccounts),
    identityMappings: scoped(context, organizationId, names.identityMappings),
    identityMappingGrants: scoped(context, organizationId, names.identityMappingGrants),
    auditEvents: scoped(context, organizationId, names.auditEvents),
    roles: scoped(context, organizationId, names.roles),
    permissions: scoped(context, organizationId, names.permissions),
    rolePermissions: scoped(context, organizationId, names.rolePermissions),
    principalRoles: scoped(context, organizationId, names.principalRoles),
    credentials: scoped(context, organizationId, names.credentials),
    sessions: scoped(context, organizationId, names.sessions),
    apiKeys: scoped(context, organizationId, names.apiKeys),
    oidcTransactions: scoped(context, organizationId, names.oidcTransactions),
  };
}

export class IdentityStorage {
  readonly organizations: Repository<Organization>;

  constructor(private readonly adapter: DatabaseAdapter) {
    this.organizations = adapter.repository<Organization>(names.organizations);
  }

  forOrganization(organizationId: string): OrganizationStores {
    return organizationStores(this.adapter, organizationId);
  }

  run<T>(
    organizationId: string,
    operation: (stores: OrganizationStores) => Promise<T>,
  ): Promise<T> {
    return this.adapter.run((context) => operation(organizationStores(context, organizationId)), {
      isolation: 'serializable',
    });
  }
}
