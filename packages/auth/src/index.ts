import type { OrganizationOwnedEntity } from '@handstack/identity';

export interface LocalCredential extends OrganizationOwnedEntity {
  readonly userId: string;
  readonly passwordHash: string;
  readonly passwordAlgorithm: 'argon2id';
  readonly changedAt: Date;
}

export interface Session extends OrganizationOwnedEntity {
  readonly principalId: string;
  readonly refreshTokenHash: string;
  readonly refreshTokenFamilyId: string;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date;
  readonly revokedAt?: Date;
}

export interface ApiKey extends OrganizationOwnedEntity {
  readonly principalId: string;
  readonly name: string;
  readonly prefix: string;
  readonly secretHash: string;
  readonly expiresAt?: Date;
  readonly lastUsedAt?: Date;
  readonly revokedAt?: Date;
}

export interface OidcAuthorizationTransaction extends OrganizationOwnedEntity {
  readonly providerId: string;
  readonly stateHash: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly expiresAt: Date;
  readonly usedAt?: Date;
}

export interface AccessTokenClaims {
  readonly subject: string;
  readonly organizationId: string;
  readonly sessionId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface LoginResult {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

export interface LocalAuthenticator {
  setPassword(organizationId: string, userId: string, password: string): Promise<void>;
  login(organizationId: string, username: string, password: string): Promise<LoginResult>;
}

export interface SessionManager {
  refresh(refreshToken: string): Promise<LoginResult>;
  revoke(organizationId: string, sessionId: string): Promise<void>;
  revokePrincipal(organizationId: string, principalId: string): Promise<void>;
}

export const frontendRefreshCookie = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
  path: '/auth',
});
