import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { KnowledgeRuntimeService } from '../src/knowledge/knowledge-runtime.service.js';
import { createApplication } from '../src/main.js';

describe('knowledge reindex HTTP contract', () => {
  let app: NestFastifyApplication;
  let token: string;
  const organizationId = 'knowledge-reindex-http-org';
  const internalServiceToken = 'knowledge-reindex-internal-service-token-at-least-32-characters';

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET =
      'knowledge-reindex-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'knowledge-reindex-token-pepper-at-least-32-characters';
    process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN = internalServiceToken;
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const auth = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'knowledge-reindex-admin',
      username: 'knowledge.reindex.admin',
      displayName: 'Knowledge Reindex Admin',
    });
    const role = await administration.createRole(organizationId, { name: 'Knowledge admin' });
    const permission = await administration.createPermission(organizationId, 'knowledge.manage');
    await administration.grantPermission(organizationId, role.id, permission.id);
    await administration.assignRole(organizationId, 'knowledge-reindex-admin', role.id);
    await auth.authentication.setPassword(
      organizationId,
      'knowledge-reindex-admin',
      'knowledge reindex admin password long enough',
    );
    token = (
      await auth.authentication.login(
        organizationId,
        'knowledge.reindex.admin',
        'knowledge reindex admin password long enough',
      )
    ).accessToken;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
    delete process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN;
  });

  it('creates, reads and cancels a tenant-scoped durable reindex job', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const baseResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/knowledge/bases`,
      headers,
      payload: {
        name: 'Reindex base',
        description: 'HTTP reindex lifecycle',
        strategy: 'PARAGRAPH',
        chunkSize: 500,
        chunkOverlap: 0,
        embeddingModel: 'old-model',
      },
    });
    expect(baseResponse.statusCode, baseResponse.body).toBe(201);
    const base = baseResponse.json<{ id: string }>();

    const createdResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/knowledge/reindex-jobs`,
      headers,
      payload: { knowledgeBaseId: base.id, embeddingModel: 'new-model' },
    });
    expect(createdResponse.statusCode, createdResponse.body).toBe(201);
    const created = createdResponse.json<{ id: string; status: string }>();
    expect(created.status).toBe('PENDING');

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/knowledge/reindex-jobs/${created.id}`,
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: created.id, organizationId, status: 'PENDING' });

    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/other-org/knowledge/reindex-jobs/${created.id}`,
      headers,
    });
    expect(crossTenant.statusCode).toBe(403);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/knowledge/reindex-jobs/${created.id}/cancel`,
      headers,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(201);
    expect(cancelled.json()).toMatchObject({ status: 'CANCELLED', cancelRequested: true });
  });

  it('requires the internal service token to execute a reindex job', async () => {
    const knowledge = app.get(KnowledgeRuntimeService);
    const base = await knowledge.createBase(organizationId, {
      name: 'Internal reindex base',
      description: 'Internal worker execution',
      chunkSize: 500,
      chunkOverlap: 0,
      strategy: 'PARAGRAPH',
      metadataExtraction: false,
      embeddingModel: 'old-model',
    });
    const job = await knowledge.createReindexJob({
      organizationId,
      knowledgeBaseId: base.id,
      embeddingModel: 'new-model',
    });
    const url = '/internal/v1/knowledge/reindex-jobs/run';
    const payload = { organizationId, jobId: job.id };

    const denied = await app.inject({ method: 'POST', url, payload });
    expect(denied.statusCode).toBe(401);

    const run = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${internalServiceToken}` },
      payload,
    });
    expect(run.statusCode, run.body).toBe(201);
    expect(run.json()).toMatchObject({
      id: job.id,
      status: 'SUCCEEDED',
      activeModelPublished: true,
    });
  });
});
