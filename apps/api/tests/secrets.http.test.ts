import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { AuditRuntimeService } from '../src/audit/audit-runtime.service.js';
import { SecretRuntimeService } from '../src/secrets/secret-runtime.service.js';
import { createApplication } from '../src/main.js';

const organizationId = 'secrets-organization';
const password = 'secrets admin password long enough';

describe('tenant secret vault HTTP contract', () => {
  let app: NestFastifyApplication;
  let token: string;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_MASTER_KEY =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'secrets-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'secrets-token-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const auth = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'secrets-admin-user',
      username: 'secrets.admin',
      displayName: 'Secrets Admin',
    });
    const role = await administration.createRole(organizationId, { name: 'Secrets admin' });
    const permission = await administration.createPermission(organizationId, 'settings.manage');
    await administration.grantPermission(organizationId, role.id, permission.id);
    await administration.assignRole(organizationId, 'secrets-admin-user', role.id);
    await auth.authentication.setPassword(organizationId, 'secrets-admin-user', password);
    token = (await auth.authentication.login(organizationId, 'secrets.admin', password))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_MASTER_KEY;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
  });

  it('stores encrypted values and never returns plaintext metadata', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/secrets`,
      headers,
      payload: { name: 'Provider key', pluginId: 'model-provider', value: 'super-secret-value' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const createdBody = JSON.parse(created.body) as { id?: unknown };
    if (typeof createdBody.id !== 'string') throw new Error('secret id missing');
    const secretId = createdBody.id;
    await expect(
      app
        .get(SecretRuntimeService)
        .resolve(`secret://${secretId}`, organizationId, 'model-provider'),
    ).resolves.toBe('super-secret-value');
    await expect(
      app.get(AuditRuntimeService).query(organizationId, 'SECRET_ACCESSED'),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: secretId, actorType: 'SYSTEM' }),
      ]),
    );
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/secrets`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain('super-secret-value');
    expect(listed.body).toContain(secretId);
    const rotated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}/secrets/${secretId}/rotate`,
      headers,
      payload: { value: 'rotated-secret-value' },
    });
    expect(rotated.statusCode).toBe(200);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/secrets/${secretId}`,
      headers,
    });
    expect(deleted.statusCode).toBe(200);
  });

  it('resolves allowlisted environment secret references through the audited broker', async () => {
    process.env.HANDSTACK_SECRET_TEST_PROVIDER = 'environment-provider-secret';
    try {
      const runtime = app.get(SecretRuntimeService);
      await expect(
        runtime.resolve('env://HANDSTACK_SECRET_TEST_PROVIDER', organizationId, 'oidc-provider'),
      ).resolves.toBe('environment-provider-secret');
      await expect(
        runtime.resolve('env://OPENAI_API_KEY', organizationId, 'oidc-provider'),
      ).rejects.toThrow(/Unsupported secret reference/);
      await expect(
        app.get(AuditRuntimeService).query(organizationId, 'SECRET_ACCESSED'),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resourceId: 'HANDSTACK_SECRET_TEST_PROVIDER',
            resourceType: 'secret-provider',
            actorType: 'SYSTEM',
          }),
        ]),
      );
    } finally {
      delete process.env.HANDSTACK_SECRET_TEST_PROVIDER;
    }
  });
});
