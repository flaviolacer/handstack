import { IdentityAdministrationService } from '@handstack/identity-service';
import { defineConfig } from '@handstack/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { EventBusRuntimeService } from '../src/core/event-bus-runtime.service.js';
import { operationQueueOptions } from '../src/operations/operations-runtime.service.js';
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
      const auditRead = await administration.createPermission(organizationId, 'audit.read');
      const workflowManage = await administration.createPermission(
        organizationId,
        'workflows.manage',
      );
      const workflowRun = await administration.createPermission(organizationId, 'workflows.run');
      await administration.grantPermission(organizationId, role.id, manage.id);
      await administration.grantPermission(organizationId, role.id, read.id);
      await administration.grantPermission(organizationId, role.id, auditRead.id);
      await administration.grantPermission(organizationId, role.id, workflowManage.id);
      await administration.grantPermission(organizationId, role.id, workflowRun.id);
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

  it('maps effective timeout and retention configuration into each operation queue', () => {
    const config = defineConfig({
      timeouts: { agent: 4_321 },
      retention: { audit: 17 },
    });
    expect(operationQueueOptions('agents', config)).toEqual({
      timeoutMs: 4_321,
      retentionMs: 17 * 86_400_000,
    });
    expect(operationQueueOptions('indexing', config).timeoutMs).toBe(120_000);
    expect(operationQueueOptions('embeddings', config).timeoutMs).toBe(30_000);
  });

  it('creates, replays, isolates and cancels an operation with ETag concurrency', async () => {
    const authorization = { authorization: `Bearer ${tokens[organizations[0]]}` };
    const eventBus = app.get(EventBusRuntimeService);
    let createdEvent: Record<string, unknown> | undefined;
    const unsubscribe = eventBus.subscribe('operation.created', (event) => {
      createdEvent = event as unknown as Record<string, unknown>;
      return Promise.resolve();
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/operations',
      headers: {
        ...authorization,
        'idempotency-key': 'operation-1',
        'x-request-id': 'request-operations-1',
        'x-trace-id': 'trace-operations-1',
      },
      payload: { type: 'knowledge.reindex' },
    });
    expect(created.statusCode).toBe(202);
    expect(created.headers.etag).toBe('"1"');
    const operation = created.json<{ id: string; status: string }>();
    expect(createdEvent).toMatchObject({
      type: 'operation.created',
      organizationId: organizations[0],
      causationId: 'request-operations-1',
      context: {
        requestId: 'request-operations-1',
        traceId: 'trace-operations-1',
        source: 'API',
      },
      payload: { operationId: operation.id, type: 'knowledge.reindex' },
    });
    const eventContext = createdEvent?.context;
    expect(typeof eventContext).toBe('object');
    if (typeof eventContext === 'object' && eventContext !== null && 'principalId' in eventContext)
      expect(typeof eventContext.principalId).toBe('string');
    unsubscribe();

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

  it('verifies the tenant audit chain and rejects cross-organization access', async () => {
    const verified = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizations[0]}/audit/verify`,
      headers: {
        authorization: `Bearer ${tokens[organizations[0]]}`,
        'x-request-id': 'audit-verify-request',
      },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ valid: true });

    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizations[0]}/audit/verify`,
      headers: { authorization: `Bearer ${tokens[organizations[1]]}` },
    });
    expect(crossTenant.statusCode).toBe(403);
  });

  it('records authenticated audit queries without leaking the query event into its response', async () => {
    const organizationId = organizations[0];
    const authorization = { authorization: `Bearer ${tokens[organizationId]}` };
    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/audit`,
      headers: { ...authorization, 'x-request-id': 'audit-query-request' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ items: { action: string }[] }>().items).not.toContainEqual(
      expect.objectContaining({ action: 'AUDIT_QUERIED' }),
    );

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/audit`,
      headers: authorization,
    });
    expect(second.statusCode).toBe(200);
    const queryEvent = second
      .json<{ items: { action: string; traceId?: string }[] }>()
      .items.find((item) => item.action === 'AUDIT_QUERIED');
    expect(queryEvent).toBeDefined();
    expect(queryEvent?.traceId).toEqual(expect.any(String));
  });

  it('propagates authenticated HTTP provenance from workflow start to operation event', async () => {
    const organizationId = organizations[0];
    const authorization = { authorization: `Bearer ${tokens[organizationId]}` };
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/workflows`,
      headers: authorization,
      payload: {
        name: 'Provenance test workflow',
        trigger: 'api',
        nodes: [{ id: 'condition', kind: 'Condition', config: {} }],
        edges: [],
      },
    });
    expect(created.statusCode).toBe(201);
    const workflow = created.json<{ id: string }>();

    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/workflows/${workflow.id}/publish`,
      headers: authorization,
    });
    expect(published.statusCode).toBe(201);

    let createdEvent: Record<string, unknown> | undefined;
    const unsubscribe = app.get(EventBusRuntimeService).subscribe('operation.created', (event) => {
      if (event.type === 'operation.created')
        createdEvent = event as unknown as Record<string, unknown>;
      return Promise.resolve();
    });
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/workflows/${workflow.id}/executions`,
      headers: {
        ...authorization,
        'idempotency-key': 'workflow-provenance-1',
        'x-request-id': 'request-workflow-http-1',
        'x-trace-id': 'trace-workflow-http-1',
      },
      payload: { trigger: 'api', payload: { source: 'http-test' } },
    });
    unsubscribe();

    expect(started.statusCode).toBe(202);
    expect(createdEvent).toMatchObject({
      causationId: 'request-workflow-http-1',
      context: {
        requestId: 'request-workflow-http-1',
        traceId: 'trace-workflow-http-1',
        principalId: `${organizationId}-user`,
        source: 'API',
      },
    });
  });
});
