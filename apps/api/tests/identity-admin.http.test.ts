import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { AuditRuntimeService } from '../src/audit/audit-runtime.service.js';
import { createApplication } from '../src/main.js';

const organizationId = 'identity-admin-organization';
const password = 'identity admin password long enough';

describe('identity administration HTTP contract', () => {
  let app: NestFastifyApplication;
  let runtime: AuthRuntimeService;
  let audit: AuditRuntimeService;
  let adminToken: string;
  let unprivilegedToken: string;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET =
      'identity-admin-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'identity-admin-token-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    runtime = app.get(AuthRuntimeService);
    audit = app.get(AuditRuntimeService);
    const administration = new IdentityAdministrationService(runtime.storage);
    await administration.createUser(organizationId, {
      id: 'identity-admin-user',
      username: 'identity.admin',
      displayName: 'Identity Admin',
    });
    await administration.createUser(organizationId, {
      id: 'identity-reader-user',
      username: 'identity.reader',
      displayName: 'Identity Reader',
    });
    await administration.createUser(organizationId, {
      id: 'break-glass-user',
      username: 'emergency.operator',
      displayName: 'Emergency Operator',
    });
    const role = await administration.createRole(organizationId, { name: 'Identity admin' });
    const permission = await administration.createPermission(organizationId, 'identity.manage');
    await administration.grantPermission(organizationId, role.id, permission.id);
    await administration.assignRole(organizationId, 'identity-admin-user', role.id);
    await administration.createGroup(organizationId, {
      id: 'mapped-engineers',
      name: 'Mapped engineers',
    });
    await administration.createRole(organizationId, {
      id: 'mapped-reviewers',
      name: 'Mapped reviewers',
    });
    await runtime.authentication.setPassword(organizationId, 'identity-admin-user', password);
    await runtime.authentication.setPassword(organizationId, 'identity-reader-user', password);
    adminToken = (await runtime.authentication.login(organizationId, 'identity.admin', password))
      .accessToken;
    unprivilegedToken = (
      await runtime.authentication.login(organizationId, 'identity.reader', password)
    ).accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
  });

  it('denies missing permission and cross-organization administration', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: `/organizations/${organizationId}/identity/providers`,
      headers: { authorization: `Bearer ${unprivilegedToken}` },
    });
    expect(denied.statusCode).toBe(403);

    const crossTenant = await app.inject({
      method: 'GET',
      url: '/organizations/another-organization/identity/providers',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(crossTenant.statusCode).toBe(403);
  });

  it('manages providers and policies without exposing secret references', async () => {
    const authorization = { authorization: `Bearer ${adminToken}` };
    const created = await app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/identity/providers`,
      headers: authorization,
      payload: {
        pluginId: 'generic-oidc',
        name: 'Corporate SSO',
        slug: 'corporate-sso',
        clientSecretReference: 'env://HANDSTACK_SECRET_CORPORATE_SSO',
        jitEnabled: true,
        configuration: {
          issuer: 'https://identity.example.test',
          clientId: 'handstack',
          redirectUri: 'https://handstack.example.test/auth/callback',
          scopes: ['openid', 'profile', 'email'],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const provider = created.json<{ id: string; hasClientSecret: boolean }>();
    expect(provider.hasClientSecret).toBe(true);
    expect(JSON.stringify(created.json())).not.toContain('HANDSTACK_SECRET_CORPORATE_SSO');
    expect(created.json()).not.toHaveProperty('clientSecretReference');

    const listed = await app.inject({
      method: 'GET',
      url: `/organizations/${organizationId}/identity/providers`,
      headers: authorization,
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).not.toContain('clientSecretReference');

    const deniedOperation = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/identity/providers/not-found/enabled`,
      headers: authorization,
      payload: { enabled: false },
    });
    expect(deniedOperation.statusCode).toBe(500);
    await expect(
      audit.query(organizationId, 'IDENTITY_ADMIN_ADMIN_PROVIDER_LIST'),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: 'identity-admin-user',
          resourceId: organizationId,
          decision: 'ALLOW',
        }),
      ]),
    );
    await expect(
      audit.query(organizationId, 'IDENTITY_ADMIN_ADMIN_PROVIDER_ENABLEMENT'),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: 'identity-admin-user',
          resourceId: organizationId,
          decision: 'DENY',
        }),
      ]),
    );

    const mappings = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/identity/providers/${provider.id}/mappings`,
      headers: authorization,
      payload: [
        {
          sourceClaim: 'groups',
          sourceValue: 'engineering',
          targetType: 'GROUP',
          targetId: 'mapped-engineers',
        },
        {
          sourceClaim: 'groups',
          sourceValue: 'reviewers',
          targetType: 'ROLE',
          targetId: 'mapped-reviewers',
        },
      ],
    });
    expect(mappings.statusCode).toBe(200);
    expect(mappings.json<unknown[]>()).toHaveLength(2);
    const listedMappings = await app.inject({
      method: 'GET',
      url: `/organizations/${organizationId}/identity/providers/${provider.id}/mappings`,
      headers: authorization,
    });
    expect(listedMappings.statusCode).toBe(200);
    expect(listedMappings.json<unknown[]>()).toHaveLength(2);

    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            issuer: 'https://identity.example.test',
            authorization_endpoint: 'https://identity.example.test/authorize',
            token_endpoint: 'https://identity.example.test/token',
            jwks_uri: 'https://identity.example.test/jwks',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'primary' }] }), { status: 200 }),
      );
    const connection = await app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/identity/providers/${provider.id}/test-connection`,
      headers: authorization,
    });
    transport.mockRestore();
    expect(connection.statusCode).toBe(201);
    expect(connection.json()).toEqual({ ok: true, stage: 'COMPLETE', code: 'CONNECTED' });
    expect(JSON.stringify(connection.json())).not.toContain('identity.example.test');
    const identityAudit = await runtime.storage
      .forOrganization(organizationId)
      .auditEvents.list({ limit: 100 });
    const connectionAudit = identityAudit.items.find(
      ({ eventType }) => eventType === 'IDENTITY_PROVIDER_CONNECTION_TESTED',
    );
    expect(connectionAudit).toMatchObject({
      outcome: 'SUCCESS',
      providerId: provider.id,
      details: { stage: 'COMPLETE', code: 'CONNECTED' },
    });
    expect(JSON.stringify(connectionAudit)).not.toContain('identity.example.test');

    const policy = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/identity/login-policy`,
      headers: authorization,
      payload: {
        mode: 'SPECIFIC_IDP_REQUIRED',
        requiredProviderId: provider.id,
        breakGlassEnabled: true,
        maxBreakGlassAccounts: 1,
      },
    });
    expect(policy.statusCode).toBe(200);

    const enabled = await app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/identity/break-glass/break-glass-user`,
      headers: authorization,
      payload: { password: 'break glass password at least twenty characters' },
    });
    expect(enabled.statusCode).toBe(201);
    expect(enabled.json()).toEqual({ enabled: true });
    expect(JSON.stringify(enabled.json())).not.toContain('password');

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/identity/break-glass/break-glass-user/disable`,
      headers: authorization,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ enabled: false });
  });

  it('deprovisions a user and invalidates an existing access token immediately', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/identity/users/identity-reader-user/deprovision`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ sessionsRevoked: number }>()).toMatchObject({ sessionsRevoked: 1 });

    const denied = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { authorization: `Bearer ${unprivilegedToken}` },
    });
    expect(denied.statusCode).toBe(401);
  });
});
