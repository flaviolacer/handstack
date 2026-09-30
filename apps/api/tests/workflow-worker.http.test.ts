import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../src/main.js';
import { OperationsRuntimeService } from '../src/operations/operations-runtime.service.js';
import { WorkflowRuntimeService } from '../src/workflows/workflow-runtime.service.js';

const organizationId = 'workflow-worker-organization';
const serviceToken = 'workflow-worker-service-token-at-least-32-characters';
const envKeys = [
  'HANDSTACK_DATABASE_ADAPTER',
  'HANDSTACK_DATABASE_URL',
  'HANDSTACK_ACCESS_TOKEN_SECRET',
  'HANDSTACK_TOKEN_PEPPER',
  'HANDSTACK_INTERNAL_SERVICE_TOKEN',
] as const;
const originalEnvironment = new Map(envKeys.map((key) => [key, process.env[key]]));

describe('workflow execution worker HTTP contract', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET =
      'workflow-worker-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'workflow-worker-token-pepper-at-least-32-characters';
    process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN = serviceToken;
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    for (const key of envKeys) {
      const value = originalEnvironment.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  it('executes only a tenant-matching durable workflow job with the service token', async () => {
    const workflows = app.get(WorkflowRuntimeService);
    const operations = app.get(OperationsRuntimeService);
    const workflow = await workflows.create({
      organizationId,
      name: 'distributed worker workflow',
      trigger: 'api',
      nodes: [{ id: 'finish', kind: 'Condition', config: {} }],
      edges: [],
    });
    await workflows.publish(organizationId, workflow.id);
    const operation = await workflows.startAsync({
      organizationId,
      workflowId: workflow.id,
      principalId: 'workflow-requester',
      context: {
        requestId: 'request-worker-http-1',
        traceId: 'trace-worker-http-1',
        principalId: 'workflow-requester',
        source: 'API',
      },
      trigger: 'api',
      payload: { fromQueue: true },
      idempotencyKey: 'workflow-worker-idempotency',
    });
    expect(operation.status).toBe('PENDING');

    const processed = await operations
      .queue('workflow-executions', organizationId)
      .process(async () => Promise.resolve());
    const queued = processed?.job;
    if (queued === undefined) throw new Error('Expected workflow execution job');
    expect(queued.payload).toMatchObject({
      context: {
        requestId: 'request-worker-http-1',
        traceId: 'trace-worker-http-1',
        principalId: 'workflow-requester',
        source: 'API',
      },
    });

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/internal/v1/workflows/execute',
      payload: JSON.stringify(queued.payload),
      headers: { 'content-type': 'application/json' },
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/workflows/execute',
      headers: {
        authorization: `Bearer ${serviceToken}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(queued.payload),
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ status: 'SUCCEEDED' });
    await expect(operations.getOperation(organizationId, operation.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/internal/v1/workflows/execute',
      headers: {
        authorization: `Bearer ${serviceToken}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(queued.payload),
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ id: operation.id, status: 'SUCCEEDED' });
  });
});
