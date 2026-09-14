import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { createApplication } from '../src/main.js';

describe('budget HTTP contract', () => {
  let app: NestFastifyApplication;
  let token: string;
  const organizationId = 'budget-http-organization';
  const password = 'budget administrator password long enough';

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'budget-http-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'budget-http-token-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const auth = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'budget-admin',
      username: 'budget.admin',
      displayName: 'Budget Admin',
    });
    const role = await administration.createRole(organizationId, { name: 'Budget administrator' });
    const permission = await administration.createPermission(organizationId, 'budget.manage');
    await administration.grantPermission(organizationId, role.id, permission.id);
    await administration.assignRole(organizationId, 'budget-admin', role.id);
    await auth.authentication.setPassword(organizationId, 'budget-admin', password);
    token = (await auth.authentication.login(organizationId, 'budget.admin', password)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
  });

  it('creates and lists tenant budgets and usage with permission and scope checks', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/budgets`,
      headers,
      payload: {
        scopeType: 'ORGANIZATION',
        scopeKey: organizationId,
        period: 'MONTHLY',
        strategy: 'HARD_LIMIT',
        limitUsd: 10,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ organizationId, strategy: 'HARD_LIMIT', limitUsd: 10 });
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/budgets`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: unknown[] }>().items).toHaveLength(1);
    const usage = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/usage`,
      headers,
    });
    expect(usage.statusCode).toBe(200);
    const pricing = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/pricing/models`,
      headers,
      payload: {
        provider: 'provider',
        model: 'model',
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(pricing.statusCode).toBe(201);
    const cross = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations/other/usage',
      headers,
    });
    expect(cross.statusCode).toBe(403);
  });
});
