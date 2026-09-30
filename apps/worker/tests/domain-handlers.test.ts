import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '@handstack/audit';
import { InMemoryWebhookDeliveryStore, InMemoryWebhookSecretProvider } from '@handstack/webhooks';
import {
  processAgentJob,
  processDocumentJob,
  processEmbeddingJob,
  processIndexingJob,
  processPluginJob,
  parseCleanupJob,
  processWebhookJob,
  processWorkflowExecutionJob,
  createWebhookSecretAccessObserver,
  enrichAuditEventWithJobContext,
} from '../src/domain-handlers.js';

const serviceToken = 'workflow-service-token-for-worker-tests-at-least-32-characters';

function requestUrl(value: RequestInfo | URL): string {
  if (typeof value === 'string') return value;
  return value instanceof URL ? value.href : value.url;
}

describe('domain worker handlers', () => {
  const originalOrganization = process.env.HANDSTACK_WORKER_ORGANIZATION_ID;
  const originalApiUrl = process.env.HANDSTACK_API_URL;
  const originalServiceToken = process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN;
  const originalApiKey = process.env.HANDSTACK_INTERNAL_API_KEY;

  afterEach(() => {
    if (originalOrganization === undefined) delete process.env.HANDSTACK_WORKER_ORGANIZATION_ID;
    else process.env.HANDSTACK_WORKER_ORGANIZATION_ID = originalOrganization;
    if (originalApiUrl === undefined) delete process.env.HANDSTACK_API_URL;
    else process.env.HANDSTACK_API_URL = originalApiUrl;
    if (originalServiceToken === undefined) delete process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN;
    else process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN = originalServiceToken;
    if (originalApiKey === undefined) delete process.env.HANDSTACK_INTERNAL_API_KEY;
    else process.env.HANDSTACK_INTERNAL_API_KEY = originalApiKey;
    vi.unstubAllGlobals();
  });

  it('accepts canonical cleanup repositories and rejects stale or unsafe names', () => {
    expect(
      parseCleanupJob({
        organizationId: ' org-worker ',
        repository: 'conversation-stream-events',
        entityIds: [' event-1 '],
      }),
    ).toEqual({
      organizationId: 'org-worker',
      repository: 'conversation-stream-events',
      entityIds: ['event-1'],
    });
    for (const repository of [
      'chat-stream-events',
      'chat-attachments',
      'conversation-attachments',
    ]) {
      expect(() =>
        parseCleanupJob({ organizationId: 'org-worker', repository, entityIds: ['entity-1'] }),
      ).toThrow('Cleanup repository is not allow-listed');
    }
  });

  it('audits webhook secret access without including secret material', async () => {
    const append = vi.fn<(event: AuditEvent) => Promise<void>>().mockResolvedValue(undefined);
    const observer = createWebhookSecretAccessObserver(append);
    await observer({ organizationId: 'org-worker', keyId: 'key-7' });
    expect(append).toHaveBeenCalledOnce();
    const event = append.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      organizationId: 'org-worker',
      actorId: 'system:webhook-worker',
      action: 'SECRET_ACCESSED',
      resourceId: 'org-worker',
      metadata: {
        pluginId: 'webhook-signing',
        keyId: 'key-7',
        provider: 'repository',
      },
    });
    expect(JSON.stringify(event)).not.toContain('webhook-secret-long-enough');
  });

  it('restores bounded durable-job provenance onto audit events', () => {
    const event: AuditEvent = {
      id: 'audit-1',
      timestamp: new Date('2026-09-28T00:00:00.000Z'),
      organizationId: 'org-worker',
      actorId: 'system:worker',
      actorType: 'SYSTEM',
      action: 'JOB_COMPLETED',
      resourceType: 'job',
      decision: 'ALLOW',
      metadata: { safe: 'value' },
    };
    const enriched = enrichAuditEventWithJobContext(event, {
      requestId: 'request-audit-1',
      traceId: 'trace-audit-1',
      principalId: 'principal-audit-1',
      source: 'API',
    });
    expect(enriched).toMatchObject({
      traceId: 'trace-audit-1',
      metadata: {
        safe: 'value',
        requestId: 'request-audit-1',
        principalId: 'principal-audit-1',
        source: 'API',
      },
    });
    expect(JSON.stringify(enriched)).not.toContain('permissions');
  });

  it('delivers a tenant-matching webhook and checkpoints completion', async () => {
    process.env.HANDSTACK_WORKER_ORGANIZATION_ID = 'org-worker';
    const secrets = new InMemoryWebhookSecretProvider();
    await secrets.put('org-worker', 'webhook-secret-long-enough', 'key-1');
    const send = vi.fn().mockResolvedValue(undefined);
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const context = {
      signal: new AbortController().signal,
      requestId: 'request-webhook-worker',
      traceId: 'trace-webhook-worker',
      principalId: 'principal-webhook-worker',
      source: 'API',
      heartbeat: vi.fn(),
      checkpoint,
    };
    await processWebhookJob(
      {
        id: 'delivery-1',
        organizationId: 'org-worker',
        event: 'user.created',
        endpoint: 'https://attacker.example.test/override',
        payload: { userId: 'u1' },
      },
      context,
      {
        endpoints: {
          get: (organizationId) =>
            Promise.resolve(
              organizationId === 'org-worker'
                ? { organizationId, endpoint: 'https://hooks.example.test/events' }
                : undefined,
            ),
          save: () => Promise.resolve(),
        },
        secrets,
        deliveries: new InMemoryWebhookDeliveryStore(),
        transport: { send },
        audit,
      },
    );
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0] as { endpoint?: unknown; signature?: unknown } | undefined;
    expect(sent?.endpoint).toBe('https://hooks.example.test/events');
    expect(typeof sent?.signature).toBe('string');
    expect(checkpoint).toHaveBeenCalledWith({ deliveryId: 'delivery-1', status: 'DELIVERED' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'webhook.delivered',
        context: {
          requestId: 'request-webhook-worker',
          traceId: 'trace-webhook-worker',
          principalId: 'principal-webhook-worker',
          source: 'API',
        },
      }),
    );
  });

  it('fails closed for a cross-tenant webhook job', async () => {
    process.env.HANDSTACK_WORKER_ORGANIZATION_ID = 'org-worker';
    await expect(
      processWebhookJob(
        {
          id: 'delivery-2',
          organizationId: 'other-org',
          event: 'user.created',
          payload: {},
        },
        { signal: new AbortController().signal, heartbeat: vi.fn(), checkpoint: vi.fn() },
        {
          endpoints: {
            get: () => Promise.resolve(undefined),
            save: () => Promise.resolve(),
          },
          secrets: new InMemoryWebhookSecretProvider(),
          deliveries: new InMemoryWebhookDeliveryStore(),
          transport: { send: vi.fn() },
        },
      ),
    ).rejects.toThrow('does not match worker organization');
  });

  it('dispatches agent, embedding and document jobs through the governed API', async () => {
    process.env.HANDSTACK_WORKER_ORGANIZATION_ID = 'org-worker';
    process.env.HANDSTACK_API_URL = 'https://api.example.test';
    process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN = 'service-token';
    process.env.HANDSTACK_INTERNAL_API_KEY = 'virtual-api-key';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 }),
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    const context = {
      signal: new AbortController().signal,
      requestId: 'request-worker-2',
      traceId: 'trace-worker-2',
      principalId: 'principal-worker-2',
      source: 'API',
      heartbeat: vi.fn(),
      checkpoint: vi.fn().mockResolvedValue(undefined),
    };
    await processAgentJob(
      { organizationId: 'org-worker', agentId: 'agent-1', prompt: 'hello' },
      context,
    );
    await processEmbeddingJob(
      { organizationId: 'org-worker', model: 'embed-1', input: ['hello'] },
      context,
    );
    await processDocumentJob(
      { organizationId: 'org-worker', documentId: 'doc-1', content: 'hello' },
      context,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      'https://api.example.test/api/v1/agents/agent-1/run',
      'https://api.example.test/v1/embeddings',
      'https://api.example.test/api/v1/organizations/org-worker/knowledge/documents/doc-1/ingest',
    ]);
    for (const [index, call] of fetcher.mock.calls.entries()) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get('x-request-id')).toBe('request-worker-2');
      expect(headers.get('x-trace-id')).toBe('trace-worker-2');
      expect(headers.get('authorization')).toBe(
        index === 1 ? 'Bearer virtual-api-key' : 'Bearer service-token',
      );
    }
    expect(context.checkpoint).toHaveBeenCalledTimes(3);
  });

  it('dispatches workflow executions through the authenticated internal API route', async () => {
    process.env.HANDSTACK_WORKER_ORGANIZATION_ID = 'org-worker';
    process.env.HANDSTACK_API_URL = 'https://api.example.test/';
    process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN = serviceToken;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: 'SUCCEEDED' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const context = {
      signal: new AbortController().signal,
      requestId: 'request-worker-3',
      traceId: 'trace-worker-3',
      principalId: 'principal-worker-3',
      source: 'API',
      heartbeat: vi.fn(),
      checkpoint: vi.fn().mockResolvedValue(undefined),
    };
    await processWorkflowExecutionJob(
      {
        organizationId: 'org-worker',
        operationId: 'operation-1',
        workflowId: 'workflow-1',
        principalId: 'principal-1',
        context: {
          requestId: 'request-worker-1',
          traceId: 'trace-worker-1',
          principalId: 'principal-1',
          source: 'API',
        },
        trigger: 'api',
        payload: { requested: true },
        idempotencyKey: 'workflow-request-1',
      },
      context,
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://api.example.test/internal/v1/workflows/execute',
    );
    const request = fetcher.mock.calls[0]?.[1];
    expect(request?.method).toBe('POST');
    expect(new Headers(request?.headers).get('authorization')).toBe(`Bearer ${serviceToken}`);
    expect(new Headers(request?.headers).get('x-request-id')).toBe('request-worker-3');
    expect(new Headers(request?.headers).get('x-trace-id')).toBe('trace-worker-3');
    const requestBody = request?.body;
    expect(typeof requestBody).toBe('string');
    if (typeof requestBody !== 'string') throw new Error('Workflow request body is missing');
    expect(requestBody).toContain('workflow-request-1');
    expect(JSON.parse(requestBody)).toMatchObject({
      context: {
        requestId: 'request-worker-1',
        traceId: 'trace-worker-1',
        principalId: 'principal-1',
        source: 'API',
      },
    });
    expect(context.heartbeat).toHaveBeenCalledOnce();
    expect(context.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'operation-1', status: 'PROCESSED' }),
    );
    await expect(
      processWorkflowExecutionJob(
        {
          organizationId: 'other-org',
          operationId: 'operation-2',
          workflowId: 'workflow-1',
          principalId: 'principal-1',
          trigger: 'api',
          payload: {},
          idempotencyKey: 'workflow-request-2',
        },
        context,
      ),
    ).rejects.toThrow('does not match worker organization');
  });

  it('reconstructs workflow provenance from the durable job envelope', async () => {
    process.env.HANDSTACK_WORKER_ORGANIZATION_ID = 'org-worker';
    process.env.HANDSTACK_API_URL = 'https://api.example.test';
    process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN = serviceToken;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: 'SUCCEEDED' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const context = {
      signal: new AbortController().signal,
      requestId: 'request-envelope-1',
      traceId: 'trace-envelope-1',
      principalId: 'principal-envelope-1',
      source: 'API',
      heartbeat: vi.fn(),
      checkpoint: vi.fn().mockResolvedValue(undefined),
    };

    await processWorkflowExecutionJob(
      {
        organizationId: 'org-worker',
        operationId: 'operation-envelope-1',
        workflowId: 'workflow-1',
        principalId: 'principal-envelope-1',
        trigger: 'api',
        payload: { requested: true },
        idempotencyKey: 'workflow-envelope-1',
      },
      context,
    );

    const body = fetcher.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toMatchObject({
      context: {
        requestId: 'request-envelope-1',
        traceId: 'trace-envelope-1',
        principalId: 'principal-envelope-1',
        source: 'API',
      },
    });
  });

  it('rejects a weak internal service token before calling the API', async () => {
    process.env.HANDSTACK_WORKER_ORGANIZATION_ID = 'org-worker';
    process.env.HANDSTACK_API_URL = 'https://api.example.test';
    process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN = 'too-short';
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      processWorkflowExecutionJob(
        {
          organizationId: 'org-worker',
          operationId: 'operation-weak-token',
          workflowId: 'workflow-1',
          principalId: 'principal-1',
          trigger: 'api',
          payload: {},
          idempotencyKey: 'workflow-weak-token',
        },
        {
          signal: new AbortController().signal,
          heartbeat: vi.fn(),
          checkpoint: vi.fn().mockResolvedValue(undefined),
        },
      ),
    ).rejects.toThrow('HANDSTACK_API_URL and HANDSTACK_INTERNAL_SERVICE_TOKEN are required');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects workflow provenance fields outside the bounded audit contract', async () => {
    await expect(
      processWorkflowExecutionJob(
        {
          organizationId: 'org-worker',
          operationId: 'operation-invalid-context',
          workflowId: 'workflow-1',
          principalId: 'principal-1',
          context: {
            requestId: 'request-1',
            traceId: 'trace-1',
            principalId: 'principal-1',
            source: 'API',
            permissions: ['admin'],
          },
          trigger: 'api',
          payload: {},
          idempotencyKey: 'workflow-invalid-context',
        },
        {
          signal: new AbortController().signal,
          heartbeat: vi.fn(),
          checkpoint: vi.fn().mockResolvedValue(undefined),
        },
      ),
    ).rejects.toThrow('Workflow job payload is invalid');
  });

  it('dispatches plugin lifecycle and indexing jobs with tenant-bound credentials', async () => {
    process.env.HANDSTACK_WORKER_ORGANIZATION_ID = 'org-worker';
    process.env.HANDSTACK_API_URL = 'https://api.example.test';
    process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN = 'service-token';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: 'SUCCEEDED' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const context = {
      signal: new AbortController().signal,
      requestId: 'request-worker-4',
      traceId: 'trace-worker-4',
      principalId: 'principal-worker-4',
      source: 'API',
      heartbeat: vi.fn(),
      checkpoint: vi.fn().mockResolvedValue(undefined),
    };
    await processPluginJob(
      { organizationId: 'org-worker', operation: 'enable', pluginName: '@handstack/demo' },
      context,
    );
    await processIndexingJob(
      { organizationId: 'org-worker', documentId: 'doc-2', content: 'reindex me' },
      context,
    );
    await processIndexingJob(
      { kind: 'knowledge.reindex', organizationId: 'org-worker', jobId: 'reindex-1' },
      context,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      headers: { authorization: 'Bearer service-token' },
    });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer service-token' },
    });
    const reindexUrl = fetcher.mock.calls[2]?.[0];
    expect(typeof reindexUrl).toBe('string');
    if (typeof reindexUrl === 'string')
      expect(reindexUrl).toBe('https://api.example.test/internal/v1/knowledge/reindex-jobs/run');
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer service-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org-worker', jobId: 'reindex-1' }),
    });
    for (const call of fetcher.mock.calls) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get('x-request-id')).toBe('request-worker-4');
      expect(headers.get('x-trace-id')).toBe('trace-worker-4');
    }
    expect(context.checkpoint).toHaveBeenCalledWith({ jobId: 'reindex-1', status: 'SUCCEEDED' });
  });
});
