import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OidcAuthorizationTransaction } from '@handstack/auth';
import type { SecretResolver } from '@handstack/core';
import { uuidV7 } from '@handstack/domain';
import type {
  ExternalIdentity,
  IdentityAuditEvent,
  OrganizationOwnedEntity,
} from '@handstack/identity';
import type {
  AuthResult,
  IdentityAuthorizationRequest,
  IdentityCallbackRequest,
  OidcIdentityProvider,
} from '@handstack/identity-sdk';
import type { IdentityStorage, ScopedRepository } from '@handstack/identity-storage';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';

interface OidcDiscovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}

export interface OidcPluginOptions {
  readonly providerId: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly resolveClientSecret?: SecretResolver;
  readonly statePepper: string;
  readonly scopes?: readonly string[];
  readonly transactionTtlSeconds?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  resolvePrincipal(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly subject: string;
    readonly claims: JWTPayload;
  }): Promise<string>;
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

export class GenericOidcPlugin implements OidcIdentityProvider {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;

  constructor(
    private readonly storage: IdentityStorage,
    private readonly options: OidcPluginOptions,
  ) {
    if (options.statePepper.length < 32) throw new TypeError('OIDC state pepper is too short');
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getAuthorizationUrl(request: IdentityAuthorizationRequest): Promise<string> {
    const discovery = await this.discovery();
    const timestamp = this.now();
    const transactionId = uuidV7(timestamp.getTime());
    const stateSecret = randomBytes(32).toString('base64url');
    const state = `hso.${encode(request.organizationId)}.${transactionId}.${stateSecret}`;
    const codeVerifier = randomBytes(32).toString('base64url');
    const transaction: OidcAuthorizationTransaction = {
      id: transactionId,
      tenantId: request.organizationId,
      organizationId: request.organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      providerId: this.options.providerId,
      stateHash: this.digest(stateSecret),
      nonce: request.nonce,
      codeVerifier,
      redirectUri: request.redirectUri,
      expiresAt: new Date(timestamp.getTime() + (this.options.transactionTtlSeconds ?? 600) * 1000),
    };
    await this.storage.forOrganization(request.organizationId).oidcTransactions.insert(transaction);
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.options.clientId,
      redirect_uri: request.redirectUri,
      scope: (this.options.scopes ?? ['openid', 'profile', 'email']).join(' '),
      state,
      nonce: request.nonce,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async handleCallback(request: IdentityCallbackRequest): Promise<AuthResult> {
    const callback = new URL(request.callbackUri);
    const code = callback.searchParams.get('code');
    const state = callback.searchParams.get('state');
    if (code === null || state === null) throw new Error('OIDC callback is missing code or state');
    const parsed = this.parseState(state);
    if (parsed.organizationId !== request.organizationId)
      throw new Error('OIDC organization mismatch');
    const transaction = await this.consumeTransaction(parsed, request.organizationId);
    const discovery = await this.discovery();
    const clientSecret = await this.options.resolveClientSecret?.();
    const tokenResponse = await this.fetcher(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.options.clientId,
        redirect_uri: transaction.redirectUri,
        code_verifier: transaction.codeVerifier,
        ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
      }),
    });
    if (!tokenResponse.ok)
      throw new Error(`OIDC token exchange failed: ${String(tokenResponse.status)}`);
    const tokens = (await tokenResponse.json()) as { id_token?: unknown };
    if (typeof tokens.id_token !== 'string') throw new Error('OIDC response is missing id_token');
    const jwksResponse = await this.fetcher(discovery.jwks_uri);
    if (!jwksResponse.ok) throw new Error('OIDC JWKS request failed');
    const jwks = (await jwksResponse.json()) as JSONWebKeySet;
    const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
      issuer: discovery.issuer,
      audience: this.options.clientId,
    });
    if (verified.payload.nonce !== transaction.nonce || verified.payload.sub === undefined) {
      throw new Error('OIDC nonce or subject is invalid');
    }
    return this.linkIdentity(request.organizationId, verified.payload.sub, verified.payload);
  }

  private async discovery(): Promise<OidcDiscovery> {
    const issuer = new URL(this.options.issuer);
    if (issuer.protocol !== 'https:') throw new Error('OIDC issuer must use HTTPS');
    const url = new URL(
      '.well-known/openid-configuration',
      `${issuer.toString().replace(/\/$/, '')}/`,
    );
    const response = await this.fetcher(url);
    if (!response.ok) throw new Error('OIDC discovery failed');
    const value = (await response.json()) as Partial<OidcDiscovery>;
    if (
      value.issuer !== this.options.issuer ||
      typeof value.authorization_endpoint !== 'string' ||
      typeof value.token_endpoint !== 'string' ||
      typeof value.jwks_uri !== 'string'
    ) {
      throw new Error('OIDC discovery document is invalid');
    }
    for (const endpoint of [value.authorization_endpoint, value.token_endpoint, value.jwks_uri]) {
      if (new URL(endpoint).protocol !== 'https:') throw new Error('OIDC endpoints must use HTTPS');
    }
    return value as OidcDiscovery;
  }

  private parseState(state: string) {
    const [prefix, encodedOrganizationId, transactionId, secret, extra] = state.split('.');
    if (
      prefix !== 'hso' ||
      encodedOrganizationId === undefined ||
      transactionId === undefined ||
      secret === undefined ||
      extra !== undefined
    ) {
      throw new Error('OIDC state is invalid');
    }
    return { organizationId: decode(encodedOrganizationId), transactionId, secret };
  }

  private async consumeTransaction(
    parsed: ReturnType<GenericOidcPlugin['parseState']>,
    organizationId: string,
  ): Promise<OidcAuthorizationTransaction> {
    return this.storage.run(organizationId, async (stores) => {
      const transaction = await stores.oidcTransactions.findById(parsed.transactionId);
      const timestamp = this.now();
      if (transaction === undefined) throw new Error('OIDC state is invalid or expired');
      if (
        transaction.providerId !== this.options.providerId ||
        transaction.usedAt !== undefined ||
        asDate(transaction.expiresAt).getTime() <= timestamp.getTime() ||
        !this.matches(parsed.secret, transaction.stateHash)
      ) {
        throw new Error('OIDC state is invalid or expired');
      }
      const consumed = {
        ...transaction,
        expiresAt: asDate(transaction.expiresAt),
        version: transaction.version + 1,
        updatedAt: timestamp,
        usedAt: timestamp,
      };
      await stores.oidcTransactions.update(consumed, transaction.version);
      return consumed;
    });
  }

  private async linkIdentity(
    organizationId: string,
    subject: string,
    claims: JWTPayload,
  ): Promise<AuthResult> {
    const principalId = await this.options.resolvePrincipal({
      organizationId,
      providerId: this.options.providerId,
      subject,
      claims,
    });
    const stores = this.storage.forOrganization(organizationId);
    const existing = (await all(stores.externalIdentities)).find(
      (identity) => identity.providerId === this.options.providerId && identity.subject === subject,
    );
    const timestamp = this.now();
    const identity: ExternalIdentity = {
      id: existing?.id ?? uuidV7(timestamp.getTime()),
      tenantId: organizationId,
      organizationId,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      principalId,
      providerId: this.options.providerId,
      subject,
      claims,
    };
    if (existing === undefined) {
      await this.storage.run(organizationId, async (transactionStores) => {
        await transactionStores.externalIdentities.insert(identity);
        const audit: IdentityAuditEvent = {
          id: uuidV7(timestamp.getTime()),
          tenantId: organizationId,
          organizationId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          eventType: 'EXTERNAL_IDENTITY_LINKED',
          outcome: 'SUCCESS',
          principalId,
          providerId: this.options.providerId,
          details: { subject },
        };
        await transactionStores.auditEvents.insert(audit);
      });
    } else await stores.externalIdentities.update(identity, existing.version);
    return { identity, authenticated: true };
  }

  private digest(secret: string): string {
    return createHmac('sha256', this.options.statePepper).update(secret).digest('base64url');
  }

  private matches(secret: string, expected: string): boolean {
    const actual = Buffer.from(this.digest(secret));
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  }
}
