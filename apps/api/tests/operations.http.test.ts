import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { createApplication } from '../src/main.js';

const password = 'operations password long enough';
const organizations = ['operations-org-a', 'operations-org-b'] as const;

describe('asynchronous operations HTTP contract', () => {
  let app: NestFastifyApplication;
  let tokens: Record<(typeof organizations)[number], string>;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'operations-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'operations-token-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const auth = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    const issued: Partial<typeof tokens> = {};

    for (const organizationId of organizations) {
      const userId = `${organizationId}-user`;
      await administration.createUser(organizationId, {
        id: userId,
        username: `${organizationId}.user`,
        displayName: organizationId,
      });
      const role = await administration.createRole(organizationId, { name: 'Operations admin' });
      const manage = await administration.createPermission(organizationId, 'operations.manage');
      const read = await administration.createPermission(organizationId, 'operations.read');
      await administration.grantPermission(organizationId, role.id, manage.id);
      await administration.grantPermission(organizationId, role.id, read.id);
      await administration.assignRole(organizationId, userId, role.id);
      await auth.authentication.setPassword(organizationId, userId, password);
      issued[organizationId] = (
        await auth.authentication.login(organizationId, `${organizationId}.user`, password)
      ).accessToken;
    }
    tokens = issued as Record<(typeof organizations)[number], string>;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
  });

  it('creates, replays, isolates and cancels an operation with ETag concurrency', async () => {
    const authorization = { authorization: `Bearer ${tokens[organizations[0]]}` };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/operations',
      headers: { ...authorization, 'idempotency-key': 'operation-1' },
      payload: { type: 'knowledge.reindex' },
    });
    expect(created.statusCode).toBe(202);
    expect(created.headers.etag).toBe('"1"');
    const operation = created.json<{ id: string; status: string }>();

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/operations',
      headers: { ...authorization, 'idempotency-key': 'operation-1' },
      payload: { type: 'knowledge.reindex' },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(created.json());

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/operations',
      headers: { ...authorization, 'idempotency-key': 'operation-1' },
      payload: { type: 'export' },
    });
    expect(conflict.statusCode).toBe(400);

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/operations/${operation.id}`,
      headers: { authorization: `Bearer ${tokens[organizations[1]]}` },
    });
    expect(hidden.statusCode).toBe(400);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/operations/${operation.id}/cancel`,
      headers: { ...authorization, 'if-match': '"1"' },
    });
    expect(cancelled.statusCode).toBe(201);
    expect(cancelled.headers.etag).toBe('"2"');
    expect(cancelled.json()).toMatchObject({ status: 'CANCELLED', cancelRequested: true });

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/operations/${operation.id}/cancel`,
      headers: { ...authorization, 'if-match': '"1"' },
    });
    expect(stale.statusCode).toBe(400);
  });
});
