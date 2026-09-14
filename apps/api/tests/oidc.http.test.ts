import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OidcRuntimeService } from '../src/auth/oidc-runtime.service.js';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { createApplication } from '../src/main.js';

describe('OIDC HTTP contract', () => {
  let app: NestFastifyApplication;
  let nonce = '';
  let tokenBody = '';

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'oidc-http-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'oidc-http-token-pepper-at-least-32-characters';
    process.env.HANDSTACK_OIDC_STATE_PEPPER = 'oidc-http-state-pepper-at-least-32-characters';
    process.env.HANDSTACK_SECRET_CORPORATE_CLIENT = 'resolved-corporate-client-secret';
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'http-key', alg: 'RS256', use: 'sig' };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith('/.well-known/openid-configuration')) {
          return Response.json({
            issuer: 'https://identity.example.com',
            authorization_endpoint: 'https://identity.example.com/authorize',
            token_endpoint: 'https://identity.example.com/token',
            jwks_uri: 'https://identity.example.com/jwks',
          });
        }
        if (url.endsWith('/token')) {
          tokenBody = init?.body instanceof URLSearchParams ? init.body.toString() : '';
          const idToken = await new SignJWT({
            nonce,
            preferred_username: 'federated.user',
            name: 'Federated User',
            email: 'federated@example.com',
            email_verified: true,
          })
            .setProtectedHeader({ alg: 'RS256', kid: 'http-key' })
            .setIssuer('https://identity.example.com')
            .setAudience('handstack-http-client')
            .setSubject('federated-subject')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);
          return Response.json({ id_token: idToken });
        }
        if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
        return new Response(null, { status: 404 });
      }),
    );
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const providers = app.get(OidcRuntimeService).providers;
    await providers.create('organization-oidc', {
      id: 'corporate-provider',
      pluginId: '@handstack/plugin-oidc',
      name: 'Corporate identity',
      slug: 'corporate',
      configuration: {
        issuer: 'https://identity.example.com',
        clientId: 'handstack-http-client',
        redirectUri: 'https://handstack.example.com/auth/oidc/organization-oidc/corporate/callback',
        scopes: ['openid', 'profile', 'email'],
      },
      clientSecretReference: 'env://HANDSTACK_SECRET_CORPORATE_CLIENT',
      provisioningPolicy: { jitEnabled: true },
    });
    await providers.setLoginPolicy('organization-oidc', {
      mode: 'SPECIFIC_IDP_REQUIRED',
      requiredProviderId: 'corporate-provider',
    });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
    delete process.env.HANDSTACK_OIDC_STATE_PEPPER;
    delete process.env.HANDSTACK_SECRET_CORPORATE_CLIENT;
  });

  it('lists only safe provider metadata and completes JIT login into a HandStack session', async () => {
    const providers = await app.inject({
      method: 'GET',
      url: '/auth/oidc/organization-oidc/providers',
    });
    expect(providers.statusCode).toBe(200);
    expect(providers.json()).toEqual([
      { name: 'Corporate identity', slug: 'corporate', type: 'OIDC', priority: 100 },
    ]);
    expect(providers.body).not.toContain('clientId');
    expect(providers.body).not.toContain('secret');

    const start = await app.inject({
      method: 'GET',
      url: '/auth/oidc/organization-oidc/corporate/start',
    });
    expect(start.statusCode).toBe(302);
    const authorizationUrl = new URL(String(start.headers.location));
    nonce = authorizationUrl.searchParams.get('nonce') ?? '';
    const state = authorizationUrl.searchParams.get('state') ?? '';
    expect(nonce).not.toBe('');
    expect(state).not.toBe('');

    const callback = await app.inject({
      method: 'GET',
      url: `/auth/oidc/organization-oidc/corporate/callback?code=valid-code&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(typeof callback.json<{ accessToken: unknown }>().accessToken).toBe('string');
    expect(callback.json()).not.toHaveProperty('refreshToken');
    expect(String(callback.headers['set-cookie'])).toContain('HttpOnly');
    expect(tokenBody).toContain('client_secret=resolved-corporate-client-secret');

    const auth = app.get(AuthRuntimeService);
    const accessToken = callback.json<{ accessToken: string }>().accessToken;
    const claims = await auth.authentication.verifyAccessToken(accessToken);
    await expect(
      auth.storage.forOrganization('organization-oidc').users.findById(claims.subject),
    ).resolves.toMatchObject({ username: 'federated.user', email: 'federated@example.com' });
    const identities = (
      await auth.storage.forOrganization('organization-oidc').externalIdentities.list({ limit: 10 })
    ).items;
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      principalId: claims.subject,
      providerId: 'corporate-provider',
      subject: 'federated-subject',
    });

    const stored = app.get(OidcRuntimeService).providers;
    await expect(stored.findEnabled('organization-oidc', 'corporate')).resolves.toMatchObject({
      id: 'corporate-provider',
    });
    const auditEvents = (
      await auth.storage.forOrganization('organization-oidc').auditEvents.list({ limit: 20 })
    ).items;
    const eventTypes = auditEvents.map((event) => event.eventType);
    expect(eventTypes).toContain('SSO_LOGIN_STARTED');
    expect(eventTypes).toContain('JIT_USER_CREATED');
    expect(eventTypes).toContain('EXTERNAL_IDENTITY_LINKED');
    expect(eventTypes).toContain('SSO_LOGIN_SUCCEEDED');
    expect(JSON.stringify(auditEvents)).not.toContain('resolved-corporate-client-secret');
  });
});
