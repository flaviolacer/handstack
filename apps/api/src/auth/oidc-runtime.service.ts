import { scopedSecretResolver, type SecretProvider } from '@handstack/core';
import type { IdentityProvider } from '@handstack/identity';
import {
  IdentityAuditService,
  IdentityProviderAdministrationService,
} from '@handstack/identity-service';
import { GenericOidcPlugin } from '@handstack/plugin-oidc';
import { Inject, Injectable } from '@nestjs/common';
import { IdentityTelemetry } from '@handstack/telemetry';
import { AuthRuntimeService } from './auth-runtime.service.js';

export type OidcConnectionTestStage = 'DISCOVERY' | 'JWKS' | 'COMPLETE';
export type OidcConnectionTestCode =
  | 'CONNECTED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'RESPONSE_TOO_LARGE'
  | 'INVALID_DOCUMENT'
  | 'ISSUER_MISMATCH'
  | 'INSECURE_ENDPOINT'
  | 'JWKS_EMPTY';

export interface OidcConnectionTestResult {
  readonly ok: boolean;
  readonly stage: OidcConnectionTestStage;
  readonly code: OidcConnectionTestCode;
}

const testTimeoutMs = 5_000;
const maximumDocumentBytes = 256 * 1024;

function secureUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

async function limitedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error('HTTP_ERROR');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumDocumentBytes) {
    throw new Error('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > maximumDocumentBytes) {
      await reader.cancel();
      throw new Error('RESPONSE_TOO_LARGE');
    }
    chunks.push(item.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new Error('INVALID_DOCUMENT');
  }
}

function failure(stage: OidcConnectionTestStage, error: unknown): OidcConnectionTestResult {
  const code = error instanceof Error ? error.message : '';
  const known: readonly OidcConnectionTestCode[] = [
    'HTTP_ERROR',
    'RESPONSE_TOO_LARGE',
    'INVALID_DOCUMENT',
    'ISSUER_MISMATCH',
    'INSECURE_ENDPOINT',
    'JWKS_EMPTY',
  ];
  return {
    ok: false,
    stage,
    code: known.includes(code as OidcConnectionTestCode)
      ? (code as OidcConnectionTestCode)
      : error instanceof DOMException && error.name === 'AbortError'
        ? 'TIMEOUT'
        : 'NETWORK_ERROR',
  };
}

export async function testOidcConnection(
  issuerValue: string,
  transport: typeof fetch = fetch,
): Promise<OidcConnectionTestResult> {
  const issuer = secureUrl(issuerValue);
  if (issuer === undefined) return { ok: false, stage: 'DISCOVERY', code: 'INSECURE_ENDPOINT' };
  const normalizedIssuer = issuer.href.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, testTimeoutMs);
  try {
    let discovery: unknown;
    try {
      discovery = await limitedJson(
        await transport(`${normalizedIssuer}/.well-known/openid-configuration`, {
          signal: controller.signal,
          redirect: 'error',
          headers: { accept: 'application/json' },
        }),
      );
    } catch (error) {
      return failure('DISCOVERY', error);
    }
    if (typeof discovery !== 'object' || discovery === null || Array.isArray(discovery)) {
      return failure('DISCOVERY', new Error('INVALID_DOCUMENT'));
    }
    const document = discovery as Record<string, unknown>;
    if (document.issuer !== normalizedIssuer) {
      return failure('DISCOVERY', new Error('ISSUER_MISMATCH'));
    }
    const authorization = secureUrl(document.authorization_endpoint);
    const token = secureUrl(document.token_endpoint);
    const jwks = secureUrl(document.jwks_uri);
    if (authorization === undefined || token === undefined || jwks === undefined) {
      return failure('DISCOVERY', new Error('INSECURE_ENDPOINT'));
    }
    try {
      const value = await limitedJson(
        await transport(jwks, {
          signal: controller.signal,
          redirect: 'error',
          headers: { accept: 'application/json' },
        }),
      );
      if (
        typeof value !== 'object' ||
        value === null ||
        !Array.isArray((value as { keys?: unknown }).keys)
      ) {
        throw new Error('INVALID_DOCUMENT');
      }
      const keys = (value as { keys: unknown[] }).keys;
      if (
        keys.length === 0 ||
        !keys.every(
          (key) =>
            typeof key === 'object' &&
            key !== null &&
            typeof (key as { kty?: unknown }).kty === 'string',
        )
      ) {
        throw new Error('JWKS_EMPTY');
      }
    } catch (error) {
      return failure('JWKS', error);
    }
    return { ok: true, stage: 'COMPLETE', code: 'CONNECTED' };
  } finally {
    clearTimeout(timer);
  }
}

class EnvironmentSecretProvider implements SecretProvider {
  get(reference: string): Promise<string | undefined> {
    const match = /^env:\/\/(HANDSTACK_SECRET_[A-Z0-9_]+)$/.exec(reference);
    if (match?.[1] === undefined) throw new TypeError('Unsupported secret reference');
    return Promise.resolve(process.env[match[1]]);
  }
}

function statePepper(): string {
  const value = process.env.HANDSTACK_OIDC_STATE_PEPPER;
  if (value !== undefined) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('HANDSTACK_OIDC_STATE_PEPPER is required in production');
  }
  return 'handstack-development-oidc-state-pepper-change-me';
}

@Injectable()
export class OidcRuntimeService {
  readonly providers: IdentityProviderAdministrationService;
  readonly audit: IdentityAuditService;
  readonly telemetry = new IdentityTelemetry();
  private readonly secrets = new EnvironmentSecretProvider();

  constructor(@Inject(AuthRuntimeService) private readonly auth: AuthRuntimeService) {
    this.providers = new IdentityProviderAdministrationService(auth.storage);
    this.audit = new IdentityAuditService(auth.storage);
  }

  plugin(provider: IdentityProvider): GenericOidcPlugin {
    return new GenericOidcPlugin(this.auth.storage, {
      providerId: provider.id,
      issuer: provider.configuration.issuer,
      clientId: provider.configuration.clientId,
      scopes: provider.configuration.scopes,
      statePepper: statePepper(),
      fetch: (input, init) => fetch(input, init),
      resolveClientSecret: scopedSecretResolver(this.secrets, provider.clientSecretReference, {
        organizationId: provider.organizationId,
        pluginId: provider.pluginId,
      }),
      resolvePrincipal: (input) => this.providers.resolvePrincipal(input),
    });
  }

  createSession(organizationId: string, principalId: string) {
    return this.auth.authentication.createFederatedSession(organizationId, principalId);
  }

  async testConnection(
    organizationId: string,
    providerId: string,
  ): Promise<OidcConnectionTestResult> {
    const provider = (await this.providers.list(organizationId)).find(
      ({ id }) => id === providerId,
    );
    if (provider === undefined) throw new Error('Identity provider not found');
    const result = await testOidcConnection(provider.configuration.issuer);
    await this.audit.record(organizationId, {
      eventType: 'IDENTITY_PROVIDER_CONNECTION_TESTED',
      outcome: result.ok ? 'SUCCESS' : 'FAILURE',
      providerId,
      details: { stage: result.stage, code: result.code },
    });
    return result;
  }
}
