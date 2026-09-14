import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { CapabilityRuntimeService } from '../src/capabilities/capability-runtime.service.js';
import { createApplication } from '../src/main.js';

describe('capability HTTP contract', () => {
  let app: NestFastifyApplication;
  let token: string;
  const organizationId = 'capability-http-organization';
  const password = 'capability administrator password long enough';

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET =
      'capability-http-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'capability-http-token-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const auth = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'capability-admin',
      username: 'capability.admin',
      displayName: 'Capability Admin',
    });
    const role = await administration.createRole(organizationId, {
      name: 'Capability administrator',
    });
    const permission = await administration.createPermission(organizationId, 'capability.execute');
    await administration.grantPermission(organizationId, role.id, permission.id);
    await administration.assignRole(organizationId, 'capability-admin', role.id);
    await auth.authentication.setPassword(organizationId, 'capability-admin', password);
    token = (await auth.authentication.login(organizationId, 'capability.admin', password))
      .accessToken;
    await app.get(CapabilityRuntimeService).registry.register({
      organizationId,
      slug: 'echo',
      name: 'Echo',
      description: 'Echo',
      type: 'CUSTOM',
      inputSchema: {},
      outputSchema: {},
      requiredPermissions: ['capability.execute'],
      allowedChannels: ['API'],
      timeoutMs: 1000,
      visibility: 'ORGANIZATION',
      ownerId: 'capability-admin',
      metadata: {},
      handler: (input) => Promise.resolve({ echoed: input }),
    });
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
  });

  it('lists and executes the same registered capability through the API authorization path', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/capabilities`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: { slug: string }[] }>().items.map((item) => item.slug)).toContain(
      'echo',
    );
    const executed = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/capabilities/echo/run`,
      headers,
      payload: { hello: 'world' },
    });
    expect(executed.statusCode).toBe(201);
    expect(executed.json()).toEqual({ echoed: { hello: 'world' } });
    const cross = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations/other/capabilities/echo/run',
      headers,
      payload: {},
    });
    expect(cross.statusCode).toBe(403);
  });
});
