import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { createApplication } from '../src/main.js';
import { ScimRuntimeService } from '../src/scim/scim-runtime.service.js';

const organizationId = 'scim-organization';
const otherOrganizationId = 'scim-other-organization';
const password = 'scim admin password long enough';

interface ScimUserResponse {
  readonly id: string;
  readonly active: boolean;
  readonly userName: string;
  readonly externalId?: string;
}
interface ScimGroupResponse {
  readonly id: string;
  readonly members: readonly { value: string }[];
}
interface ScimListResponse {
  readonly totalResults: number;
}

describe('SCIM 2.0 HTTP contract', () => {
  let app: NestFastifyApplication;
  let runtime: AuthRuntimeService;
  let scim: ScimRuntimeService;
  let adminToken: string;
  let unprivilegedToken: string;
  let scimToken: string;
  let otherScimToken: string;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'scim-access-secret-at-least-32-characters-long';
    process.env.HANDSTACK_TOKEN_PEPPER = 'scim-token-pepper-at-least-32-characters-long';
    process.env.HANDSTACK_SCIM_TOKEN_PEPPER = 'scim-bearer-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    runtime = app.get(AuthRuntimeService);
    scim = app.get(ScimRuntimeService);

    const administration = new IdentityAdministrationService(runtime.storage);
    await administration.createUser(organizationId, {
      id: 'scim-admin-user',
      username: 'scim.admin',
      displayName: 'SCIM Admin',
    });
    await administration.createUser(organizationId, {
      id: 'scim-reader-user',
      username: 'scim.reader',
      displayName: 'SCIM Reader',
    });
    const role = await administration.createRole(organizationId, { name: 'SCIM admin' });
    const permission = await administration.createPermission(organizationId, 'identity.manage');
    await administration.grantPermission(organizationId, role.id, permission.id);
    await administration.assignRole(organizationId, 'scim-admin-user', role.id);
    await runtime.authentication.setPassword(organizationId, 'scim-admin-user', password);
    await runtime.authentication.setPassword(organizationId, 'scim-reader-user', password);
    adminToken = (await runtime.authentication.login(organizationId, 'scim.admin', password))
      .accessToken;
    unprivilegedToken = (
      await runtime.authentication.login(organizationId, 'scim.reader', password)
    ).accessToken;

    scimToken = (await scim.credentials.issue(organizationId)).token;
    otherScimToken = (await scim.credentials.issue(otherOrganizationId)).token;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
    delete process.env.HANDSTACK_SCIM_TOKEN_PEPPER;
  });

  it('requires a valid dedicated SCIM bearer token', async () => {
    const missing = await app.inject({ method: 'GET', url: '/scim/v2/Users' });
    expect(missing.statusCode).toBe(401);
    const invalid = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users',
      headers: { authorization: 'Bearer hs_scim_invalid' },
    });
    expect(invalid.statusCode).toBe(401);
  });

  it('serves SCIM discovery endpoints', async () => {
    const headers = { authorization: `Bearer ${scimToken}` };
    const config = await app.inject({
      method: 'GET',
      url: '/scim/v2/ServiceProviderConfig',
      headers,
    });
    expect(config.statusCode).toBe(200);
    expect(config.json<{ etag: { supported: boolean } }>().etag).toEqual({ supported: true });

    const resourceTypes = await app.inject({
      method: 'GET',
      url: '/scim/v2/ResourceTypes',
      headers,
    });
    expect(resourceTypes.statusCode).toBe(200);
    expect(resourceTypes.json<ScimListResponse>().totalResults).toBe(2);
  });

  it('creates, lists, reads and updates users with optimistic concurrency', async () => {
    const headers = { authorization: `Bearer ${scimToken}` };
    const created = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers,
      payload: {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        externalId: 'ext-alice',
        userName: 'alice',
        displayName: 'Alice Example',
        emails: [{ value: 'alice@example.com', primary: true }],
      },
    });
    expect(created.statusCode).toBe(201);
    const user = created.json<ScimUserResponse>();
    expect(created.headers.location).toBe(`/scim/v2/Users/${user.id}`);
    expect(created.headers.etag).toBe('W/"1"');
    expect(user.active).toBe(true);
    expect(user.userName).toBe('alice');

    // Idempotent externalId upsert returns the same resource.
    const duplicate = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers,
      payload: { externalId: 'ext-alice', userName: 'alice', displayName: 'Alice Example' },
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json<ScimUserResponse>().id).toBe(user.id);

    const listed = await app.inject({ method: 'GET', url: '/scim/v2/Users', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<ScimListResponse>().totalResults).toBe(1);

    const read = await app.inject({
      method: 'GET',
      url: `/scim/v2/Users/${user.id}`,
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers.etag).toBe('W/"1"');

    // Deactivate with the correct version.
    const deactivated = await app.inject({
      method: 'PATCH',
      url: `/scim/v2/Users/${user.id}`,
      headers: { ...headers, 'if-match': 'W/"1"' },
      payload: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      },
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json<ScimUserResponse>().active).toBe(false);
    expect(deactivated.headers.etag).toBe('W/"2"');

    // Stale version conflicts.
    const conflict = await app.inject({
      method: 'PATCH',
      url: `/scim/v2/Users/${user.id}`,
      headers: { ...headers, 'if-match': 'W/"1"' },
      payload: { active: true },
    });
    expect(conflict.statusCode).toBe(409);

    const notFound = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users/missing',
      headers,
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('filters users by externalId and deletes with a version', async () => {
    const headers = { authorization: `Bearer ${scimToken}` };
    const created = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers,
      payload: { externalId: 'ext-filter', userName: 'filtered', displayName: 'Filtered User' },
    });
    const id = created.json<ScimUserResponse>().id;

    const filtered = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users?filter=externalId%20eq%20%22ext-filter%22',
      headers,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json<ScimListResponse>().totalResults).toBe(1);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/scim/v2/Users/${id}`,
      headers: { ...headers, 'if-match': 'W/"1"' },
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('manages groups and memberships with tenant isolation', async () => {
    const headers = { authorization: `Bearer ${scimToken}` };
    const first = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers,
      payload: { externalId: 'ext-g1', userName: 'g1', displayName: 'G1' },
    });
    const firstId = first.json<ScimUserResponse>().id;

    const group = await app.inject({
      method: 'POST',
      url: '/scim/v2/Groups',
      headers,
      payload: { displayName: 'developers', members: [{ value: firstId }] },
    });
    expect(group.statusCode).toBe(201);
    const createdGroup = group.json<ScimGroupResponse>();
    expect(createdGroup.members).toHaveLength(1);
    const groupId = createdGroup.id;

    const second = await app.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers,
      payload: { externalId: 'ext-g2', userName: 'g2', displayName: 'G2' },
    });
    const secondId = second.json<ScimUserResponse>().id;

    const withSecond = await app.inject({
      method: 'PATCH',
      url: `/scim/v2/Groups/${groupId}`,
      headers: { ...headers, 'if-match': 'W/"1"' },
      payload: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'add', path: 'members', value: [{ value: secondId }] }],
      },
    });
    expect(withSecond.statusCode).toBe(200);
    expect(withSecond.json<ScimGroupResponse>().members).toHaveLength(2);

    // A tenant-scoped token cannot read another organization's data.
    const otherList = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users',
      headers: { authorization: `Bearer ${otherScimToken}` },
    });
    expect(otherList.json<ScimListResponse>().totalResults).toBe(0);
  });

  it('issues and revokes the dedicated credential through the admin API', async () => {
    const endpoint = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/scim`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(endpoint.statusCode).toBe(200);
    expect(endpoint.json<{ baseUrl: string; hasCredential: boolean }>().baseUrl).toBe('/scim/v2');
    expect(endpoint.json<{ hasCredential: boolean }>().hasCredential).toBe(true);

    // An unprivileged principal cannot administer SCIM credentials.
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/scim/credential`,
      headers: { authorization: `Bearer ${unprivilegedToken}` },
    });
    expect(denied.statusCode).toBe(403);

    const rotated = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/scim/credential`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(rotated.statusCode).toBe(201);
    const token = rotated.json<{ token: string }>().token;
    expect(token.startsWith('hs_scim_')).toBe(true);
    const authenticated = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authenticated.statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/scim/credential`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(revoked.statusCode).toBe(200);
    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/scim/v2/Users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });
});
