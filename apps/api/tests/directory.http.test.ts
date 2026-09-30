import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { createApplication } from '../src/main.js';

const organizationId = 'directory-http-organization';
const password = 'directory admin password long enough';

describe('tenant-scoped directory HTTP contract', () => {
  let app: NestFastifyApplication;
  let token: string;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'directory-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'directory-token-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const auth = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'directory-admin-user',
      username: 'directory.admin',
      displayName: 'Directory Admin',
    });
    const role = await administration.createRole(organizationId, { name: 'Directory admin' });
    const permission = await administration.createPermission(organizationId, 'identity.manage');
    await administration.grantPermission(organizationId, role.id, permission.id);
    const policyPermission = await administration.createPermission(organizationId, 'policy.manage');
    await administration.grantPermission(organizationId, role.id, policyPermission.id);
    await administration.assignRole(organizationId, 'directory-admin-user', role.id);
    await auth.authentication.setPassword(organizationId, 'directory-admin-user', password);
    token = (await auth.authentication.login(organizationId, 'directory.admin', password))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
  });

  it('creates and updates users, groups and roles through the authenticated API', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const createdUser = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/users`,
      headers,
      payload: { username: 'managed.user', displayName: 'Managed User' },
    });
    expect(createdUser.statusCode).toBe(201);

    const createdGroup = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/groups`,
      headers,
      payload: { name: 'Engineering' },
    });
    expect(createdGroup.statusCode).toBe(201);

    const createdRole = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/roles`,
      headers,
      payload: { name: 'Reviewer' },
    });
    expect(createdRole.statusCode).toBe(201);

    const userId = createdUser.json<{ id: string }>().id;
    const groupId = createdGroup.json<{ id: string }>().id;
    const roleId = createdRole.json<{ id: string }>().id;
    const updatedUser = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}/users/${userId}`,
      headers,
      payload: { displayName: 'Managed User Updated' },
    });
    expect(updatedUser.statusCode).toBe(200);
    expect(updatedUser.json()).toMatchObject({ id: userId, displayName: 'Managed User Updated' });

    const membership = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/group-memberships`,
      headers,
      payload: { groupId, principalId: userId },
    });
    expect(membership.statusCode).toBe(201);
    const assignment = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/principal-roles`,
      headers,
      payload: { principalId: userId, roleId },
    });
    expect(assignment.statusCode).toBe(201);

    const memberships = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/group-memberships`,
      headers,
    });
    expect(memberships.statusCode).toBe(200);
    expect(memberships.json<{ items: unknown[] }>().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ groupId, principalId: userId })]),
    );
  });

  it('rejects organization mismatch and missing administrative permission', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const crossTenant = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations/other-organization/users',
      headers,
    });
    expect(crossTenant.statusCode).toBe(403);

    const auth = app.get(AuthRuntimeService);
    await auth.authentication.setPassword(organizationId, 'directory-admin-user', password);
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/roles`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('applies tenant-scoped authorization policies through Configuration as Code API', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/policies`,
      headers,
      payload: {
        principalIds: ['directory-admin-user'],
        resource: 'support',
        action: 'read',
        effect: 'allow',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      organizationId,
      resource: 'support',
      action: 'read',
      effect: 'allow',
    });
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/policies`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: unknown[] }>().items).toHaveLength(1);
    const crossTenant = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations/other-organization/policies',
      headers,
    });
    expect(crossTenant.statusCode).toBe(403);
  });
});
