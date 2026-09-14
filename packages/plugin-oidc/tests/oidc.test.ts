import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { IdentityStorage } from '@handstack/identity-storage';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GenericOidcPlugin } from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('generic OIDC plugin', () => {
  it('uses discovery, PKCE, one-time state, nonce and signed ID token validation', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const storage = new IdentityStorage(adapter);
      const user = await new IdentityAdministrationService(storage).createUser('organization-a', {
        id: 'user-a',
        username: 'ana.silva',
        displayName: 'Ana Silva',
      });
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
      let expectedNonce = '';
      let tokenRequestBody = '';
      const fetcher = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith('/.well-known/openid-configuration')) {
          return Response.json({
            issuer: 'https://issuer.example',
            authorization_endpoint: 'https://issuer.example/authorize',
            token_endpoint: 'https://issuer.example/token',
            jwks_uri: 'https://issuer.example/jwks',
          });
        }
        if (url === 'https://issuer.example/token') {
          tokenRequestBody = init?.body instanceof URLSearchParams ? init.body.toString() : '';
          const idToken = await new SignJWT({ nonce: expectedNonce, email: 'ana@example.com' })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setIssuer('https://issuer.example')
            .setAudience('handstack-client')
            .setSubject('external-ana')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);
          return Response.json({ id_token: idToken });
        }
        if (url === 'https://issuer.example/jwks') return Response.json({ keys: [jwk] });
        return new Response(null, { status: 404 });
      };
      const plugin = new GenericOidcPlugin(storage, {
        providerId: 'corporate-oidc',
        issuer: 'https://issuer.example',
        clientId: 'handstack-client',
        statePepper: 'oidc-state-pepper-with-at-least-32-characters',
        resolveClientSecret: () => Promise.resolve('resolved-client-secret'),
        fetch: fetcher,
        resolvePrincipal: () => Promise.resolve(user.id),
      });
      expectedNonce = 'nonce-from-browser';
      const authorizationUrl = new URL(
        await plugin.getAuthorizationUrl({
          organizationId: 'organization-a',
          redirectUri: 'https://handstack.example/auth/oidc/callback',
          state: 'caller-state',
          nonce: expectedNonce,
        }),
      );
      expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy();
      expect(authorizationUrl.searchParams.get('nonce')).toBe(expectedNonce);
      const state = authorizationUrl.searchParams.get('state');
      expect(state).toBeTruthy();

      const callbackUri = `https://handstack.example/auth/oidc/callback?code=valid-code&state=${encodeURIComponent(state ?? '')}`;
      const result = await plugin.handleCallback({
        organizationId: 'organization-a',
        callbackUri,
        state: state ?? '',
      });
      expect(result).toMatchObject({
        authenticated: true,
        identity: {
          principalId: user.id,
          providerId: 'corporate-oidc',
          subject: 'external-ana',
        },
      });
      expect(tokenRequestBody).toContain('client_secret=resolved-client-secret');
      await expect(
        plugin.handleCallback({
          organizationId: 'organization-a',
          callbackUri,
          state: state ?? '',
        }),
      ).rejects.toThrow(/state is invalid or expired/);
    } finally {
      await adapter.close();
    }
  });
});
