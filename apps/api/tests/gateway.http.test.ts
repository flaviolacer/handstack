import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { createApplication } from '../src/main.js';

const organizationId = 'gateway-http-organization';
const password = 'gateway administrator password long enough';

describe('gateway virtual API key HTTP contract', () => {
  let app: NestFastifyApplication;
  let runtime: AuthRuntimeService;
  let adminToken: string;
  let readerToken: string;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'gateway-http-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'gateway-http-token-pepper-at-least-32-characters';
    process.env.HANDSTACK_GATEWAY_KEY_PEPPER = 'gateway-http-key-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    runtime = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(runtime.storage);
    await administration.createUser(organizationId, {
      id: 'gateway-admin',
      username: 'gateway.admin',
      displayName: 'Gateway Admin',
    });
    await administration.createUser(organizationId, {
      id: 'gateway-reader',
      username: 'gateway.reader',
      displayName: 'Gateway Reader',
    });
    const role = await administration.createRole(organizationId, { name: 'Gateway administrator' });
    const permission = await administration.createPermission(organizationId, 'api-key.manage');
    await administration.grantPermission(organizationId, role.id, permission.id);
    await administration.assignRole(organizationId, 'gateway-admin', role.id);
    await runtime.authentication.setPassword(organizationId, 'gateway-admin', password);
    await runtime.authentication.setPassword(organizationId, 'gateway-reader', password);
    adminToken = (await runtime.authentication.login(organizationId, 'gateway.admin', password))
      .accessToken;
    readerToken = (await runtime.authentication.login(organizationId, 'gateway.reader', password))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
    delete process.env.HANDSTACK_GATEWAY_KEY_PEPPER;
  });

  it('enforces permission and organization scope', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/gateway/keys`,
      headers: { authorization: `Bearer ${readerToken}` },
    });
    expect(denied.statusCode).toBe(403);
    const crossTenant = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations/another-organization/gateway/keys',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(crossTenant.statusCode).toBe(403);
  });

  it('issues once, lists without hash, revokes and audits', async () => {
    const headers = { authorization: `Bearer ${adminToken}` };
    const issued = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/gateway/keys`,
      headers,
      payload: {
        ownerId: 'gateway-admin',
        ownerType: 'USER',
        name: 'CLI integration',
        environment: 'test',
        permissions: ['models.execute'],
        models: ['smart'],
      },
    });
    expect(issued.statusCode).toBe(201);
    const payload = issued.json<{ key: { id: string; secretHash?: string }; secret: string }>();
    expect(payload.secret).toMatch(/^hs_test_/);
    expect(payload.key).not.toHaveProperty('secretHash');

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/gateway/keys`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).not.toContain(payload.secret);
    expect(JSON.stringify(listed.json())).not.toContain('secretHash');

    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/gateway/keys/${payload.key.id}/revoke`,
      headers,
    });
    expect(revoked.statusCode).toBe(201);
    expect(revoked.json()).toEqual({ revoked: true, id: payload.key.id });
    const audit = await runtime.storage
      .forOrganization(organizationId)
      .auditEvents.list({ limit: 100 });
    expect(audit.items.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['VIRTUAL_API_KEY_ISSUED', 'VIRTUAL_API_KEY_REVOKED']),
    );
    expect(JSON.stringify(audit.items)).not.toContain(payload.secret);

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/gateway/keys`,
      headers,
      payload: {
        ownerId: 'gateway-admin',
        ownerType: 'USER',
        name: 'OpenAI client',
        environment: 'test',
        permissions: ['models.execute'],
      },
    });
    expect(second.statusCode).toBe(201);
    const secondSecret = second.json<{ secret: string }>().secret;
    const directKey = await app
      .get((await import('../src/gateway/gateway-runtime.service.js')).GatewayRuntimeService)
      .keys.authenticate(secondSecret);
    expect(directKey.models).toEqual([]);
    const directModels = await app
      .get((await import('../src/models/model-admin-runtime.service.js')).ModelAdminRuntimeService)
      .registry.listModels(organizationId);
    expect(directModels.items).toHaveLength(0);
    const models = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${secondSecret}` },
    });
    expect(models.statusCode, models.body).toBe(200);
    expect(models.json()).toMatchObject({ object: 'list', data: [] });
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${secondSecret}` },
      payload: { model: 'smart', messages: [] },
    });
    expect(malformed.statusCode).toBe(400);
  });
});
