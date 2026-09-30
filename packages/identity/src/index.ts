import type { TenantEntity } from '@handstack/domain';

export type PrincipalType = 'USER' | 'SERVICE_ACCOUNT' | 'APPLICATION' | 'AGENT' | 'API_KEY';
export type IdentityStatus = 'ACTIVE' | 'DISABLED';

export interface OrganizationOwnedEntity extends TenantEntity {
  readonly organizationId: string;
}

export interface Organization extends Omit<TenantEntity, 'tenantId'> {
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: IdentityStatus;
}

export interface Branding {
  readonly displayName: string;
  readonly productName: string;
  readonly logo?: string;
  readonly favicon?: string;
  readonly primaryColor: string;
  readonly secondaryColor: string;
  readonly accentColor: string;
  readonly backgroundColor: string;
  readonly font?: string;
  readonly loginBackground?: string;
  readonly customCss?: string;
  readonly customDomain?: string;
  readonly welcomeMessage?: string;
  readonly legalLinks: readonly { readonly label: string; readonly url: string }[];
  readonly supportUrl?: string;
}

export interface OrganizationSettings extends OrganizationOwnedEntity {
  readonly branding: Branding;
  readonly locale: string;
  readonly timezone: string;
  readonly theme: 'light' | 'dark' | 'system' | 'custom';
  /** Optional tenant-scoped runtime overrides; primary database selection is never accepted here. */
  readonly configuration?: Readonly<Record<string, unknown>>;
}

export interface Principal extends OrganizationOwnedEntity {
  readonly type: PrincipalType;
  readonly status: IdentityStatus;
  readonly displayName: string;
}

export interface User extends Principal {
  readonly type: 'USER';
  readonly username: string;
  readonly normalizedUsername: string;
  readonly email?: string;
}

export interface OrganizationMembership extends OrganizationOwnedEntity {
  readonly userId: string;
  readonly status: IdentityStatus;
}

export interface Group extends OrganizationOwnedEntity {
  readonly name: string;
  readonly description?: string;
}

export interface GroupMembership extends OrganizationOwnedEntity {
  readonly groupId: string;
  readonly principalId: string;
}

export interface ExternalIdentity extends OrganizationOwnedEntity {
  readonly principalId: string;
  readonly providerId: string;
  readonly subject: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

export interface IdentityProvider extends OrganizationOwnedEntity {
  readonly pluginId: string;
  readonly name: string;
  readonly slug: string;
  readonly type: 'OIDC';
  readonly enabled: boolean;
  readonly priority: number;
  readonly configuration: {
    readonly issuer: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly scopes: readonly string[];
  };
  readonly clientSecretReference?: string;
  readonly loginPolicy: {
    readonly accountLinking: 'DISABLED' | 'VERIFIED_EMAIL';
  };
  readonly provisioningPolicy: {
    readonly jitEnabled: boolean;
  };
  readonly mappingPolicy: {
    readonly usernameClaim: string;
    readonly displayNameClaim: string;
    readonly emailClaim: string;
  };
}

export type OrganizationLoginMode =
  'LOCAL_ALLOWED' | 'LOCAL_DISABLED' | 'SSO_REQUIRED' | 'SPECIFIC_IDP_REQUIRED';

export interface OrganizationLoginPolicy extends OrganizationOwnedEntity {
  readonly mode: OrganizationLoginMode;
  readonly requiredProviderId?: string;
  readonly breakGlassEnabled: boolean;
  readonly maxBreakGlassAccounts: number;
}

export interface BreakGlassAccount extends OrganizationOwnedEntity {
  readonly userId: string;
  readonly enabled: boolean;
}

export interface IdentityMapping extends OrganizationOwnedEntity {
  readonly identityProviderId: string;
  readonly sourceClaim: string;
  readonly sourceValue: string;
  readonly targetType: 'GROUP' | 'ROLE';
  readonly targetId: string;
  readonly enabled: boolean;
}

export interface IdentityMappingGrant extends OrganizationOwnedEntity {
  readonly identityProviderId: string;
  readonly mappingId: string;
  readonly principalId: string;
  readonly targetType: 'GROUP' | 'ROLE';
  readonly targetId: string;
  readonly assignmentId: string;
}

export type IdentityAuditEventType =
  | 'IDENTITY_PROVIDER_CREATED'
  | 'IDENTITY_PROVIDER_UPDATED'
  | 'IDENTITY_PROVIDER_DISABLED'
  | 'LOGIN_POLICY_UPDATED'
  | 'LOCAL_LOGIN_SUCCEEDED'
  | 'LOCAL_LOGIN_FAILED'
  | 'SSO_LOGIN_STARTED'
  | 'SSO_LOGIN_SUCCEEDED'
  | 'SSO_LOGIN_FAILED'
  | 'JIT_USER_CREATED'
  | 'EXTERNAL_IDENTITY_LINKED'
  | 'BREAK_GLASS_ENABLED'
  | 'BREAK_GLASS_DISABLED'
  | 'BREAK_GLASS_LOGIN'
  | 'USER_DEPROVISIONED'
  | 'IDENTITY_MAPPINGS_UPDATED'
  | 'IDENTITY_MEMBERSHIPS_RECONCILED'
  | 'IDENTITY_PROVIDER_CONNECTION_TESTED'
  | 'VIRTUAL_API_KEY_ISSUED'
  | 'VIRTUAL_API_KEY_REVOKED';

export interface IdentityAuditEvent extends OrganizationOwnedEntity {
  readonly eventType: IdentityAuditEventType;
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly principalId?: string;
  readonly providerId?: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export function assertOrganizationScope(entity: OrganizationOwnedEntity): void {
  if (entity.organizationId.length === 0 || entity.tenantId !== entity.organizationId) {
    throw new TypeError('tenantId must equal organizationId for organization-owned identity data');
  }
}

export function normalizeUsername(username: string): string {
  const normalized = username.trim().normalize('NFKC').toLocaleLowerCase('en-US');
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(normalized)) {
    throw new TypeError('Username must contain 3-128 safe characters');
  }
  return normalized;
}
