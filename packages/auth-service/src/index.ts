import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  ApiKey,
  AccessTokenClaims,
  LocalCredential,
  LoginResult,
  Session,
} from '@handstack/auth';
import { uuidV7 } from '@handstack/domain';
import {
  normalizeUsername,
  type BreakGlassAccount,
  type IdentityAuditEvent,
  type IdentityAuditEventType,
  type OrganizationOwnedEntity,
  type User,
} from '@handstack/identity';
import {
  type IdentityStorage,
  type OrganizationStores,
  type ScopedRepository,
} from '@handstack/identity-storage';
import { AuthenticationError } from '@handstack/shared';
import { hash, verify } from '@node-rs/argon2';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

export interface AuthServiceOptions {
  readonly accessTokenSecret: string;
  readonly tokenPepper: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly accessTokenTtlSeconds?: number;
  readonly refreshTokenTtlSeconds?: number;
  readonly now?: () => Date;
}

export interface IssuedApiKey {
  readonly apiKey: ApiKey;
  readonly secret: string;
}

function base(organizationId: string, id: string, timestamp: Date) {
  return {
    id,
    tenantId: organizationId,
    organizationId,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function audit(
  organizationId: string,
  eventType: IdentityAuditEventType,
  outcome: IdentityAuditEvent['outcome'],
  input: { readonly principalId?: string; readonly details?: IdentityAuditEvent['details'] } = {},
): IdentityAuditEvent {
  const timestamp = new Date();
  return {
    ...base(organizationId, uuidV7(timestamp.getTime()), timestamp),
    eventType,
    outcome,
    ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
    details: input.details ?? {},
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

function encode(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('Invalid persisted date');
  return date;
}

function parseOpaque(token: string, prefix: 'hsr' | 'hsk') {
  const [actualPrefix, encodedOrganizationId, id, secret, extra] = token.split('.');
  if (
    actualPrefix !== prefix ||
    encodedOrganizationId === undefined ||
    id === undefined ||
    secret === undefined ||
    extra !== undefined
  ) {
    throw new Error('Invalid credential');
  }
  return { organizationId: decode(encodedOrganizationId), id, secret };
}

export class AuthenticationService {
  private readonly signingKey: Uint8Array;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly now: () => Date;

  constructor(
    private readonly storage: IdentityStorage,
    private readonly options: AuthServiceOptions,
  ) {
    if (options.accessTokenSecret.length < 32 || options.tokenPepper.length < 32) {
      throw new TypeError('Authentication secrets must contain at least 32 characters');
    }
    this.signingKey = new TextEncoder().encode(options.accessTokenSecret);
    this.accessTtl = options.accessTokenTtlSeconds ?? 300;
    this.refreshTtl = options.refreshTokenTtlSeconds ?? 2_592_000;
    this.issuer = options.issuer ?? 'handstack';
    this.audience = options.audience ?? 'handstack-api';
    this.now = options.now ?? (() => new Date());
  }

  setPassword(organizationId: string, userId: string, password: string): Promise<void> {
    if (password.length < 12 || password.length > 1024) {
      throw new TypeError('Password must contain 12-1024 characters');
    }
    return this.storage.run(organizationId, async (stores) => {
      if ((await stores.users.findById(userId)) === undefined) throw new Error('User not found');
      const timestamp = this.now();
      const passwordHash = await hash(password, {
        algorithm: 2,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });
      const existing = await stores.credentials.findById(userId);
      const credential: LocalCredential = {
        ...base(organizationId, userId, timestamp),
        ...(existing === undefined
          ? {}
          : { version: existing.version + 1, createdAt: existing.createdAt }),
        userId,
        passwordHash,
        passwordAlgorithm: 'argon2id',
        changedAt: timestamp,
      };
      if (existing === undefined) await stores.credentials.insert(credential);
      else await stores.credentials.update(credential, existing.version);
    });
  }

  async login(organizationId: string, username: string, password: string): Promise<LoginResult> {
    try {
      return await this.storage.run(organizationId, async (stores) => {
        const normalized = normalizeUsername(username);
        const user = (await all(stores.users)).find(
          (candidate) =>
            candidate.normalizedUsername === normalized && candidate.status === 'ACTIVE',
        );
        if (user === undefined) throw new AuthenticationError('Invalid credentials');
        const credential = await stores.credentials.findById(user.id);
        if (credential === undefined || !(await verify(credential.passwordHash, password))) {
          throw new AuthenticationError('Invalid credentials');
        }
        const policy = await stores.loginPolicies.findById(organizationId);
        const breakGlass = await stores.breakGlassAccounts.findById(user.id);
        const usesBreakGlass =
          policy !== undefined &&
          policy.mode !== 'LOCAL_ALLOWED' &&
          policy.breakGlassEnabled &&
          breakGlass?.enabled === true;
        if (policy !== undefined && policy.mode !== 'LOCAL_ALLOWED' && !usesBreakGlass) {
          throw new AuthenticationError('Local login is disabled by organization policy');
        }
        const result = await this.createSession(stores, user);
        await stores.auditEvents.insert(
          audit(
            organizationId,
            usesBreakGlass ? 'BREAK_GLASS_LOGIN' : 'LOCAL_LOGIN_SUCCEEDED',
            'SUCCESS',
            { principalId: user.id },
          ),
        );
        return result;
      });
    } catch (error) {
      await this.storage
        .forOrganization(organizationId)
        .auditEvents.insert(
          audit(organizationId, 'LOCAL_LOGIN_FAILED', 'FAILURE', {
            details: { reason: error instanceof Error ? error.name : 'UnknownError' },
          }),
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async enableBreakGlass(organizationId: string, userId: string, password: string): Promise<void> {
    if (password.length < 20) {
      throw new TypeError('Break-glass password must contain at least 20 characters');
    }
    const stores = this.storage.forOrganization(organizationId);
    const policy = await stores.loginPolicies.findById(organizationId);
    if (policy?.breakGlassEnabled !== true) {
      throw new Error('Break-glass access is not enabled by organization policy');
    }
    const existing = await stores.breakGlassAccounts.findById(userId);
    const enabled = (await all(stores.breakGlassAccounts)).filter(
      (account) => account.enabled && account.id !== userId,
    );
    if (enabled.length >= policy.maxBreakGlassAccounts) {
      throw new Error('Break-glass account limit reached');
    }
    await this.setPassword(organizationId, userId, password);
    await this.storage.run(organizationId, async (transactionStores) => {
      const timestamp = this.now();
      const account: BreakGlassAccount = {
        ...base(organizationId, userId, timestamp),
        ...(existing === undefined
          ? {}
          : { version: existing.version + 1, createdAt: existing.createdAt }),
        userId,
        enabled: true,
      };
      if (existing === undefined) await transactionStores.breakGlassAccounts.insert(account);
      else await transactionStores.breakGlassAccounts.update(account, existing.version);
      await transactionStores.auditEvents.insert(
        audit(organizationId, 'BREAK_GLASS_ENABLED', 'SUCCESS', { principalId: userId }),
      );
    });
  }

  disableBreakGlass(organizationId: string, userId: string): Promise<void> {
    return this.storage.run(organizationId, async (stores) => {
      const existing = await stores.breakGlassAccounts.findById(userId);
      if (existing?.enabled !== true) return;
      const timestamp = this.now();
      await stores.breakGlassAccounts.update(
        {
          ...existing,
          version: existing.version + 1,
          updatedAt: timestamp,
          enabled: false,
        },
        existing.version,
      );
      await stores.auditEvents.insert(
        audit(organizationId, 'BREAK_GLASS_DISABLED', 'SUCCESS', { principalId: userId }),
      );
    });
  }

  createFederatedSession(organizationId: string, principalId: string): Promise<LoginResult> {
    return this.storage.run(organizationId, async (stores) => {
      const user = await stores.users.findById(principalId);
      if (user?.status !== 'ACTIVE') {
        throw new AuthenticationError('Federated principal is not active');
      }
      return this.createSession(stores, user);
    });
  }

  async refresh(refreshToken: string): Promise<LoginResult> {
    const parsed = parseOpaque(refreshToken, 'hsr');
    const result = await this.storage.run(parsed.organizationId, async (stores) => {
      const session = await stores.sessions.findById(parsed.id);
      if (session === undefined || session.revokedAt !== undefined)
        throw new AuthenticationError('Invalid session');
      const timestamp = this.now();
      const expiresAt = asDate(session.expiresAt);
      if (expiresAt.getTime() <= timestamp.getTime()) {
        throw new AuthenticationError('Session expired');
      }
      if (!this.hashMatches(parsed.secret, session.refreshTokenHash)) {
        await stores.sessions.update(
          { ...session, version: session.version + 1, updatedAt: timestamp, revokedAt: timestamp },
          session.version,
        );
        return undefined;
      }
      const nextSecret = this.randomSecret();
      const updated: Session = {
        ...session,
        version: session.version + 1,
        updatedAt: timestamp,
        lastUsedAt: timestamp,
        expiresAt,
        refreshTokenHash: this.digest(nextSecret),
      };
      await stores.sessions.update(updated, session.version);
      return this.loginResult(updated, nextSecret);
    });
    if (result === undefined) throw new AuthenticationError('Refresh token reuse detected');
    return result;
  }

  revoke(organizationId: string, sessionId: string): Promise<void> {
    return this.storage.run(organizationId, async (stores) => {
      const session = await stores.sessions.findById(sessionId);
      if (session === undefined || session.revokedAt !== undefined) return;
      const timestamp = this.now();
      await stores.sessions.update(
        { ...session, version: session.version + 1, updatedAt: timestamp, revokedAt: timestamp },
        session.version,
      );
    });
  }

  revokePrincipal(organizationId: string, principalId: string): Promise<void> {
    return this.storage.run(organizationId, async (stores) => {
      const timestamp = this.now();
      const sessions = (await all(stores.sessions)).filter(
        (session) => session.principalId === principalId && session.revokedAt === undefined,
      );
      for (const session of sessions) {
        await stores.sessions.update(
          { ...session, version: session.version + 1, updatedAt: timestamp, revokedAt: timestamp },
          session.version,
        );
      }
    });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.signingKey, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
      }));
    } catch (error) {
      throw new AuthenticationError('Invalid access token', { cause: error });
    }
    if (
      payload.sub === undefined ||
      typeof payload.organizationId !== 'string' ||
      typeof payload.sessionId !== 'string' ||
      payload.iat === undefined ||
      payload.exp === undefined
    ) {
      throw new AuthenticationError('Invalid access token claims');
    }
    const claims = {
      subject: payload.sub,
      organizationId: payload.organizationId,
      sessionId: payload.sessionId,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
    const stores = this.storage.forOrganization(claims.organizationId);
    const [session, user] = await Promise.all([
      stores.sessions.findById(claims.sessionId),
      stores.users.findById(claims.subject),
    ]);
    const now = this.now().getTime();
    if (
      session?.principalId !== claims.subject ||
      session.revokedAt !== undefined ||
      asDate(session.expiresAt).getTime() <= now ||
      user?.status !== 'ACTIVE'
    ) {
      throw new AuthenticationError('Session is not active');
    }
    return claims;
  }

  issueApiKey(
    organizationId: string,
    principalId: string,
    name: string,
    expiresAt?: Date,
  ): Promise<IssuedApiKey> {
    return this.storage.run(organizationId, async (stores) => {
      if ((await stores.principals.findById(principalId)) === undefined) {
        throw new Error('Principal not found');
      }
      const timestamp = this.now();
      const id = uuidV7(timestamp.getTime());
      const secretPart = this.randomSecret();
      const prefix = secretPart.slice(0, 8);
      const apiKey: ApiKey = {
        ...base(organizationId, id, timestamp),
        principalId,
        name: name.trim(),
        prefix,
        secretHash: this.digest(secretPart),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
      await stores.apiKeys.insert(apiKey);
      return { apiKey, secret: `hsk.${encode(organizationId)}.${id}.${secretPart}` };
    });
  }

  async authenticateApiKey(secret: string): Promise<ApiKey> {
    const parsed = parseOpaque(secret, 'hsk');
    const stores = this.storage.forOrganization(parsed.organizationId);
    const apiKey = await stores.apiKeys.findById(parsed.id);
    const principal =
      apiKey === undefined ? undefined : await stores.principals.findById(apiKey.principalId);
    const timestamp = this.now();
    if (
      apiKey === undefined ||
      principal?.status !== 'ACTIVE' ||
      apiKey.revokedAt !== undefined ||
      (apiKey.expiresAt !== undefined &&
        asDate(apiKey.expiresAt).getTime() <= timestamp.getTime()) ||
      !this.hashMatches(parsed.secret, apiKey.secretHash)
    ) {
      throw new AuthenticationError('Invalid API key');
    }
    return apiKey;
  }

  revokeApiKey(organizationId: string, apiKeyId: string): Promise<void> {
    return this.storage.run(organizationId, async (stores) => {
      const apiKey = await stores.apiKeys.findById(apiKeyId);
      if (apiKey === undefined || apiKey.revokedAt !== undefined) return;
      const timestamp = this.now();
      await stores.apiKeys.update(
        { ...apiKey, version: apiKey.version + 1, updatedAt: timestamp, revokedAt: timestamp },
        apiKey.version,
      );
    });
  }

  private async createSession(stores: OrganizationStores, user: User): Promise<LoginResult> {
    const timestamp = this.now();
    const id = uuidV7(timestamp.getTime());
    const secret = this.randomSecret();
    const session: Session = {
      ...base(user.organizationId, id, timestamp),
      principalId: user.id,
      refreshTokenHash: this.digest(secret),
      refreshTokenFamilyId: uuidV7(timestamp.getTime()),
      expiresAt: new Date(timestamp.getTime() + this.refreshTtl * 1000),
      lastUsedAt: timestamp,
    };
    await stores.sessions.insert(session);
    return this.loginResult(session, secret);
  }

  private async loginResult(session: Session, secret: string): Promise<LoginResult> {
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const expiresAt = issuedAt + this.accessTtl;
    const accessToken = await new SignJWT({
      organizationId: session.organizationId,
      sessionId: session.id,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(session.principalId)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.signingKey);
    return {
      accessToken,
      accessTokenExpiresAt: new Date(expiresAt * 1000),
      refreshToken: `hsr.${encode(session.organizationId)}.${session.id}.${secret}`,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  private randomSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  private digest(secret: string): string {
    return createHmac('sha256', this.options.tokenPepper).update(secret).digest('base64url');
  }

  private hashMatches(secret: string, expected: string): boolean {
    const actual = Buffer.from(this.digest(secret));
    const expectedBuffer = Buffer.from(expected);
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  }
}
