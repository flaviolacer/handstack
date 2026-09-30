import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { AgentRuntimeService } from '../src/agents/agent-runtime.service.js';
import { createApplication } from '../src/main.js';

describe('public agent HTTP contract', () => {
  let app: NestFastifyApplication;
  let token: string;
  const organizationId = 'agent-http-organization';
  const password = 'agent http password long enough';

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'agent-http-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'agent-http-token-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const auth = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'agent-user',
      username: 'agent.user',
      displayName: 'Agent User',
    });
    const role = await administration.createRole(organizationId, { name: 'Agent runner' });
    for (const name of ['agents.execute', 'safe.read']) {
      const permission = await administration.createPermission(organizationId, name);
      await administration.grantPermission(organizationId, role.id, permission.id);
    }
    await administration.assignRole(organizationId, 'agent-user', role.id);
    await auth.authentication.setPassword(organizationId, 'agent-user', password);
    token = (await auth.authentication.login(organizationId, 'agent.user', password)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
  });

  it('ignores requested body permissions and passes only effective RBAC permissions', async () => {
    const run = vi.spyOn(app.get(AgentRuntimeService), 'runPublished').mockResolvedValue({
      runId: 'agent-http-run',
      content: 'ok',
      iterations: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/agent-1/run',
        headers: { authorization: `Bearer ${token}` },
        payload: { prompt: 'hello', permissions: ['admin.write'] },
      });
      expect(response.statusCode).toBe(201);
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ permissions: ['agents.execute', 'safe.read'] }),
      );
    } finally {
      run.mockRestore();
    }
  });

  it('accepts the repository input shown in the public SDK example', async () => {
    const run = vi.spyOn(app.get(AgentRuntimeService), 'runPublished').mockResolvedValue({
      runId: 'agent-repository-run',
      content: 'ok',
      iterations: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/security-review/run',
        headers: { authorization: `Bearer ${token}` },
        payload: { repository: 'acme/repository' },
      });
      expect(response.statusCode).toBe(201);
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'Review repository: acme/repository' }),
      );
    } finally {
      run.mockRestore();
    }
  });
});
