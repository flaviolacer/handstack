import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { createApplication } from '../src/main.js';

const organizationId = 'access-governance-http-organization';
const password = 'access governance administrator password';

describe('access governance HTTP contract', () => {
  let app: NestFastifyApplication;
  let token: string;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'access-http-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'access-http-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const auth = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'access-admin',
      username: 'access.admin',
      displayName: 'Access Admin',
    });
    const role = await administration.createRole(organizationId, { name: 'Access administrator' });
    for (const name of ['access.request', 'access.approve', 'access.read']) {
      const permission = await administration.createPermission(organizationId, name);
      await administration.grantPermission(organizationId, role.id, permission.id);
    }
    await administration.assignRole(organizationId, 'access-admin', role.id);
    await auth.authentication.setPassword(organizationId, 'access-admin', password);
    token = (await auth.authentication.login(organizationId, 'access.admin', password)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
  });

  it('rejects a grant revocation under the wrong request and accepts the matching request', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const submitted = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/access-requests`,
      headers,
      payload: { resource: 'repo:private', reason: 'incident', duration: '1h' },
    });
    expect(submitted.statusCode).toBe(201);
    const requestId = submitted.json<{ id: string }>().id;

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/access-requests/${requestId}/approve`,
      headers,
      payload: { approverId: 'access-admin' },
    });
    expect(approved.statusCode).toBe(201);
    const grantId = approved.json<{ id: string }>().id;

    const wrongRequest = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/access-requests/wrong-request/grants/${grantId}/revoke`,
      headers,
    });
    expect(wrongRequest.statusCode).toBe(400);

    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/access-requests/${requestId}/grants/${grantId}/revoke`,
      headers,
    });
    expect(revoked.statusCode).toBe(201);
    const revokedBody = revoked.json<{ id: string; requestId: string; revokedAt?: string }>();
    expect(revokedBody).toMatchObject({ id: grantId, requestId });
    expect(revokedBody.revokedAt).toEqual(expect.any(String));
  });
});
