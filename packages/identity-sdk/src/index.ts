import type { ExternalIdentity } from '@handstack/identity';

export const identityProviderCapabilities = [
  'identity.oidc',
  'identity.oauth2',
  'identity.saml',
  'identity.ldap',
  'identity.scim',
  'identity.jit',
  'identity.user-sync',
  'identity.group-sync',
  'identity.attribute-mapping',
  'identity.logout',
  'identity.session-revocation',
] as const;

export type IdentityProviderCapability = (typeof identityProviderCapabilities)[number];

export interface AuthenticationRequest {
  readonly organizationId: string;
  readonly credentials: Readonly<Record<string, unknown>>;
}

export interface AuthResult {
  readonly identity: ExternalIdentity;
  readonly authenticated: boolean;
}

export interface IdentityAuthorizationRequest {
  readonly organizationId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
}

export interface IdentityCallbackRequest {
  readonly organizationId: string;
  readonly callbackUri: string;
  readonly state: string;
}

export interface AuthenticationProvider {
  authenticate(request: AuthenticationRequest): Promise<AuthResult>;
}

export interface OidcIdentityProvider {
  getAuthorizationUrl(request: IdentityAuthorizationRequest): Promise<string>;
  handleCallback(request: IdentityCallbackRequest): Promise<AuthResult>;
  refreshIdentity?(identity: ExternalIdentity): Promise<ExternalIdentity>;
}

export interface LogoutProvider {
  logout(request: { readonly organizationId: string; readonly principalId: string }): Promise<void>;
}

export interface SessionRevocationProvider {
  revokeSessions(request: {
    readonly organizationId: string;
    readonly principalId: string;
  }): Promise<void>;
}

export function isIdentityProviderCapability(value: string): value is IdentityProviderCapability {
  return (identityProviderCapabilities as readonly string[]).includes(value);
}
