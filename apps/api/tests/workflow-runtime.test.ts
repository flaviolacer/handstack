import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { IdentityStorage } from '@handstack/identity-storage';
import { defineConfig } from '@handstack/config';
import { Redis } from 'ioredis';
import { DatabaseService } from '../src/database/database.service.js';
import { OperationsRuntimeService } from '../src/operations/operations-runtime.service.js';
import { EventBusRuntimeService } from '../src/core/event-bus-runtime.service.js';
import { WorkflowRuntimeService } from '../src/workflows/workflow-runtime.service.js';
import { WorkflowSchedulerService } from '../src/workflows/workflow-scheduler.service.js';

afterEach(() => {
  delete process.env.HANDSTACK_DATABASE_ADAPTER;
  delete process.env.HANDSTACK_DATABASE_URL;
  delete process.env.HANDSTACK_WORKFLOW_SCHEDULER_ENABLED;
  delete process.env.HANDSTACK_WORKFLOW_SCHEDULER_ORGANIZATIONS;
  delete process.env.HANDSTACK_WORKFLOW_SCHEDULER_PRINCIPAL;
  delete process.env.HANDSTACK_WORKFLOW_SCHEDULER_INTERVAL_MS;
  delete process.env.HANDSTACK_WORKFLOW_SCHEDULER_INSTANCE_ID;
});

const eventRedisUrl = process.env.HANDSTACK_TEST_REDIS_URL?.trim();

describe('WorkflowRuntimeService', () => {
  it('runs the configured scheduler for explicit organizations and prevents overlap', async () => {
    const dispatchDueSchedules = vi.fn().mockResolvedValue([]);
    const scheduler = new WorkflowSchedulerService({ dispatchDueSchedules } as never);
    process.env.HANDSTACK_WORKFLOW_SCHEDULER_ORGANIZATIONS = 'org-a, org-b, org-a';
    await scheduler.tick(undefined, new Date());
    expect(dispatchDueSchedules).toHaveBeenCalledTimes(2);
    expect(dispatchDueSchedules).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: 'scheduler',
        payload: { source: 'workflow-scheduler' },
      }),
    );
  });

  it('discovers active organizations from the database when no allow-list is configured', async () => {
    const dispatchDueSchedules = vi.fn().mockResolvedValue([]);
    const listAll = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          { id: 'org-active', status: 'ACTIVE' },
          { id: 'org-disabled', status: 'DISABLED' },
        ],
        nextCursor: 'next-page',
      })
      .mockResolvedValueOnce({ items: [{ id: 'org-active-2', status: 'ACTIVE' }] });
    const scheduler = new WorkflowSchedulerService(
      { dispatchDueSchedules } as never,
      { adapter: { listAll } } as never,
    );

    await scheduler.tick(undefined, new Date());

    expect(listAll).toHaveBeenNthCalledWith(1, 'identity-organizations', { limit: 200 });
    expect(listAll).toHaveBeenNthCalledWith(2, 'identity-organizations', {
      limit: 200,
      cursor: 'next-page',
    });
    expect(dispatchDueSchedules).toHaveBeenCalledTimes(2);
    expect(dispatchDueSchedules).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-active' }),
    );
    expect(dispatchDueSchedules).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-active-2' }),
    );
  });

  it('skips a tenant owned by another live scheduler lease', async () => {
    const dispatchDueSchedules = vi.fn().mockResolvedValue([]);
    const lease = {
      id: 'org-leased:workflow-scheduler',
      tenantId: 'org-leased',
      organizationId: 'org-leased',
      ownerId: 'scheduler-other',
      leaseUntil: Date.now() + 60_000,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const repository = {
      findById: vi.fn().mockResolvedValue(lease),
      insert: vi.fn(),
      update: vi.fn(),
    };
    process.env.HANDSTACK_WORKFLOW_SCHEDULER_INSTANCE_ID = 'scheduler-this';
    const scheduler = new WorkflowSchedulerService(
      { dispatchDueSchedules } as never,
      { adapter: { repository: vi.fn().mockReturnValue(repository) } } as never,
    );
    await scheduler.tick(['org-leased'], new Date());
    expect(dispatchDueSchedules).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('dispatches executable Agent, Capability and LLM nodes to their governed runtimes', async () => {
    const runPublished = vi.fn().mockResolvedValue({ content: 'agent result' });
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const chat = vi
      .fn()
      .mockResolvedValue({ content: 'llm result', usage: { inputTokens: 1, outputTokens: 1 } });
    const runtime = new WorkflowRuntimeService(
      undefined,
      undefined,
      { runPublished } as never,
      { engine: { execute } } as never,
      { execution: { chat } } as never,
    );
    const workflow = await runtime.create({
      organizationId: 'org-execution',
      name: 'executors',
      trigger: 'manual',
      nodes: [
        { id: 'agent', kind: 'Agent', config: { agentId: 'agent-1' } },
        { id: 'capability', kind: 'Capability', config: { slug: 'capability-1' } },
        { id: 'llm', kind: 'LLM', config: { model: 'model-1' } },
      ],
      edges: [
        { from: 'agent', to: 'capability' },
        { from: 'capability', to: 'llm' },
      ],
    });
    await runtime.publish('org-execution', workflow.id);
    const execution = await runtime.start({
      organizationId: 'org-execution',
      workflowId: workflow.id,
      principalId: 'user-1',
      trigger: 'manual',
      payload: 'input',
    });
    expect(execution.status).toBe('COMPLETED');
    expect(runPublished).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', prompt: 'input' }),
    );
    expect(execute).toHaveBeenCalledWith(
      'capability-1',
      expect.objectContaining({ content: 'agent result' }),
      expect.objectContaining({ channel: 'INTERNAL' }),
    );
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ model: 'model-1' }));
    expect(execution.output).toBe('llm result');
  });

  it('propagates the authenticated principal permissions into Agent and MCP nodes', async () => {
    const runPublished = vi.fn().mockResolvedValue({ content: 'agent result' });
    const capability = vi.fn().mockResolvedValue({ content: 'capability result' });
    const execute = vi.fn().mockResolvedValue({ content: 'mcp result' });
    const list = (items: unknown[]) => ({ items });
    const auth = {
      storage: {
        forOrganization: vi.fn().mockReturnValue({
          principalRoles: {
            list: vi.fn().mockResolvedValue(list([{ principalId: 'user-1', roleId: 'role-1' }])),
          },
          rolePermissions: {
            list: vi
              .fn()
              .mockResolvedValue(list([{ roleId: 'role-1', permissionId: 'permission-1' }])),
          },
          permissions: {
            list: vi
              .fn()
              .mockResolvedValue(list([{ id: 'permission-1', resource: 'mcp', action: 'use' }])),
          },
        }),
      },
    };
    const runtime = new WorkflowRuntimeService(
      undefined,
      undefined,
      { runPublished } as never,
      { engine: { execute: capability } } as never,
      undefined,
      { execute } as never,
      auth as never,
    );
    const workflow = await runtime.create({
      organizationId: 'org-permissions',
      name: 'governed',
      trigger: 'manual',
      nodes: [
        { id: 'agent', kind: 'Agent', config: { agentId: 'agent-1' } },
        { id: 'capability', kind: 'Capability', config: { slug: 'capability-1' } },
        { id: 'mcp', kind: 'MCP', config: { serverId: 'server-1', toolName: 'tool-1' } },
      ],
      edges: [
        { from: 'agent', to: 'capability' },
        { from: 'capability', to: 'mcp' },
      ],
    });
    await runtime.publish('org-permissions', workflow.id);
    await runtime.start({
      organizationId: 'org-permissions',
      workflowId: workflow.id,
      principalId: 'user-1',
      trigger: 'manual',
      payload: 'input',
    });
    expect(runPublished).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ['mcp.use'] }),
    );
    expect(capability).toHaveBeenCalledWith(
      'capability-1',
      { content: 'agent result' },
      expect.objectContaining({ permissions: ['mcp.use'], principalId: 'user-1' }),
    );
    expect(execute).toHaveBeenCalledWith(
      'org-permissions',
      'server-1',
      'tool-1',
      { content: 'capability result' },
      expect.objectContaining({ permissions: ['mcp.use'], principalId: 'user-1' }),
    );
  });

  it('keeps definitions and executions tenant-scoped', async () => {
    const runtime = new WorkflowRuntimeService();
    const workflow = await runtime.create({
      organizationId: 'org-1',
      name: 'release',
      trigger: 'manual',
      nodes: [{ id: 'first', kind: 'Condition', config: {} }],
      edges: [],
    });
    expect(await runtime.list('org-2')).toHaveLength(0);
    await expect(runtime.get('org-2', workflow.id)).rejects.toThrow('Workflow not found');
    await runtime.publish('org-1', workflow.id);
    const execution = await runtime.start({
      organizationId: 'org-1',
      workflowId: workflow.id,
      principalId: 'user-1',
      trigger: 'manual',
      payload: { ok: true },
    });
    expect(execution.status).toBe('COMPLETED');
    await expect(runtime.getExecution('org-2', execution.id)).rejects.toThrow(
      'Workflow execution not found',
    );
  });

  it('waits for and resumes after human approval', async () => {
    const runtime = new WorkflowRuntimeService();
    const workflow = await runtime.create({
      organizationId: 'org-1',
      name: 'approval',
      trigger: 'api',
      nodes: [
        { id: 'approval', kind: 'Human Approval', config: { approvers: ['reviewer'] } },
        { id: 'done', kind: 'Condition', config: {} },
      ],
      edges: [{ from: 'approval', to: 'done' }],
    });
    await runtime.publish('org-1', workflow.id);
    const waiting = await runtime.start({
      organizationId: 'org-1',
      workflowId: workflow.id,
      principalId: 'requester',
      trigger: 'api',
      payload: null,
    });
    expect(waiting.status).toBe('WAITING_APPROVAL');
    await expect(runtime.listSteps('org-1', waiting.id)).resolves.toEqual([
      expect.objectContaining({ nodeId: 'approval', status: 'WAITING_APPROVAL' }),
    ]);
    const completed = await runtime.approve({
      organizationId: 'org-1',
      executionId: waiting.id,
      approverId: 'reviewer',
    });
    expect(completed.status).toBe('COMPLETED');
  });

  it('dispatches only published workflows matching the event trigger', async () => {
    const runtime = new WorkflowRuntimeService();
    const matching = await runtime.create({
      organizationId: 'org-events',
      name: 'matching',
      trigger: 'event',
      triggerConfig: { eventName: 'document.updated' },
      nodes: [{ id: 'done', kind: 'Condition', config: {} }],
      edges: [],
    });
    const other = await runtime.create({
      organizationId: 'org-events',
      name: 'other',
      trigger: 'event',
      triggerConfig: { eventName: 'document.deleted' },
      nodes: [{ id: 'done', kind: 'Condition', config: {} }],
      edges: [],
    });
    await runtime.publish('org-events', matching.id);
    await runtime.publish('org-events', other.id);
    const executions = await runtime.dispatchEvent({
      organizationId: 'org-events',
      eventName: 'document.updated',
      principalId: 'service-account',
      payload: { documentId: 'doc-1' },
    });
    expect(executions).toHaveLength(1);
    expect(executions[0]?.workflowId).toBe(matching.id);
    expect(executions[0]?.status).toBe('COMPLETED');
  });

  it('subscribes published event workflows and preserves event provenance into the worker job', async () => {
    const eventBus = new EventBusRuntimeService();
    const operations = new OperationsRuntimeService(undefined, undefined, eventBus);
    const runtime = new WorkflowRuntimeService(
      undefined,
      operations,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      eventBus,
    );
    let createdEvent: Record<string, unknown> | undefined;
    eventBus.subscribe('operation.created', (event) => {
      createdEvent = event as unknown as Record<string, unknown>;
      return Promise.resolve();
    });
    const workflow = await runtime.create({
      organizationId: 'org-event-bus',
      name: 'document event workflow',
      trigger: 'event',
      triggerConfig: { eventName: 'document.updated' },
      nodes: [{ id: 'done', kind: 'Condition', config: {} }],
      edges: [],
    });
    await runtime.publish('org-event-bus', workflow.id);

    await eventBus.publish({
      id: 'document.updated:foreign-event',
      type: 'document.updated',
      schemaVersion: 1,
      organizationId: 'org-foreign',
      timestamp: new Date().toISOString(),
      correlationId: 'trace-foreign-event',
      idempotencyKey: 'document-updated-foreign',
      payload: { documentId: 'private-doc' },
    });
    expect(createdEvent).toBeUndefined();

    await eventBus.publish({
      id: 'document.updated:event-1',
      type: 'document.updated',
      schemaVersion: 1,
      organizationId: 'org-event-bus',
      timestamp: new Date().toISOString(),
      correlationId: 'trace-document-event-1',
      idempotencyKey: 'document-updated-1',
      context: {
        requestId: 'request-document-event-1',
        traceId: 'trace-document-event-1',
        principalId: 'document-user',
        source: 'API',
      },
      payload: { documentId: 'doc-1' },
    });

    expect(createdEvent).toMatchObject({
      type: 'operation.created',
      causationId: 'request-document-event-1',
      context: {
        requestId: 'request-document-event-1',
        traceId: 'trace-document-event-1',
        principalId: 'document-user',
        source: 'API',
      },
    });
    const processed = await operations
      .queue('workflow-executions', 'org-event-bus')
      .process(() => Promise.resolve());
    expect(processed?.job.payload).toMatchObject({
      workflowId: workflow.id,
      principalId: 'document-user',
      trigger: 'event',
      context: {
        requestId: 'request-document-event-1',
        traceId: 'trace-document-event-1',
        principalId: 'document-user',
        source: 'API',
      },
      payload: { documentId: 'doc-1' },
    });
    const payload = processed?.job.payload;
    if (typeof payload !== 'object' || payload === null)
      throw new Error('Workflow event job payload is not an object');
    const idempotencyKey = (payload as Record<string, unknown>).idempotencyKey;
    expect(typeof idempotencyKey).toBe('string');
    expect(String(idempotencyKey)).toMatch(/^event:[a-f0-9]{64}$/u);
    runtime.onModuleDestroy();
  });

  it('restores event subscriptions for published workflows after API restart', async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    const database = new DatabaseService();
    await database.onModuleInit();
    const eventBus = new EventBusRuntimeService();
    const operations = new OperationsRuntimeService(undefined, undefined, eventBus);
    const organizationId = 'org-event-restart';
    const identity = new IdentityAdministrationService(new IdentityStorage(database.adapter));
    await identity.createOrganization({ id: organizationId, name: 'Events', slug: 'events' });
    const first = new WorkflowRuntimeService(database);
    const workflow = await first.create({
      organizationId,
      name: 'restored event workflow',
      trigger: 'event',
      triggerConfig: { eventName: 'asset.created' },
      nodes: [{ id: 'done', kind: 'Condition', config: {} }],
      edges: [],
    });
    await first.publish(organizationId, workflow.id);
    first.onModuleDestroy();

    const restarted = new WorkflowRuntimeService(
      database,
      operations,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      eventBus,
    );
    try {
      await restarted.onModuleInit();
      await eventBus.publish({
        id: 'asset.created:event-1',
        type: 'asset.created',
        schemaVersion: 1,
        organizationId,
        timestamp: new Date().toISOString(),
        correlationId: 'asset-created-trace',
        idempotencyKey: 'asset-created-1',
        payload: { assetId: 'asset-1' },
      });
      const processed = await operations
        .queue('workflow-executions', organizationId)
        .process(() => Promise.resolve());
      expect(processed?.job.payload).toMatchObject({
        workflowId: workflow.id,
        trigger: 'event',
        payload: { assetId: 'asset-1' },
        context: {
          requestId: 'asset.created:event-1',
          traceId: 'asset-created-trace',
          source: 'SYSTEM',
        },
      });
    } finally {
      restarted.onModuleDestroy();
      await eventBus.onModuleDestroy();
      await database.onModuleDestroy();
    }
  });

  it.skipIf(eventRedisUrl === undefined || eventRedisUrl === '')(
    'dispatches restored tenant workflows from Redis Streams with stable provenance',
    async () => {
      process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
      process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
      const database = new DatabaseService();
      await database.onModuleInit();
      const namespace = `handstack:test:workflow-events:${String(Date.now())}`;
      const config = defineConfig({
        deployment: { profile: 'distributed' },
        queue: {
          redisUrl: eventRedisUrl,
          namespaces: { streams: namespace },
          pendingClaimIdleMs: 0,
        },
      });
      const eventBus = new EventBusRuntimeService({ config } as never);
      const operations = new OperationsRuntimeService(undefined, undefined, eventBus);
      const organizationId = 'org-redis-event-trigger';
      const identity = new IdentityAdministrationService(new IdentityStorage(database.adapter));
      await identity.createOrganization({
        id: organizationId,
        name: 'Redis Events',
        slug: 'redis-events',
      });
      const first = new WorkflowRuntimeService(database);
      const workflow = await first.create({
        organizationId,
        name: 'Redis event workflow',
        trigger: 'event',
        triggerConfig: { eventName: 'inventory.changed' },
        nodes: [{ id: 'done', kind: 'Condition', config: {} }],
        edges: [],
      });
      await first.publish(organizationId, workflow.id);
      first.onModuleDestroy();
      const restarted = new WorkflowRuntimeService(
        database,
        operations,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        eventBus,
      );
      const redis = new Redis(eventRedisUrl ?? '');
      try {
        await restarted.onModuleInit();
        await eventBus.publish({
          id: 'inventory.changed:event-redis-1',
          type: 'inventory.changed',
          schemaVersion: 1,
          organizationId,
          timestamp: new Date().toISOString(),
          correlationId: 'inventory-trace-1',
          idempotencyKey: 'inventory-event-1',
          context: {
            requestId: 'inventory-request-1',
            traceId: 'inventory-trace-1',
            principalId: 'inventory-user',
            source: 'API',
          },
          payload: { sku: 'SKU-1' },
        });
        const queue = operations.queue('workflow-executions', organizationId);
        let processed: Awaited<ReturnType<typeof queue.process>>;
        const deadline = Date.now() + 5_000;
        do {
          processed = await queue.process(() => Promise.resolve());
          if (processed !== undefined) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        expect(processed?.job.payload).toMatchObject({
          workflowId: workflow.id,
          trigger: 'event',
          principalId: 'inventory-user',
          context: {
            requestId: 'inventory-request-1',
            traceId: 'inventory-trace-1',
            source: 'API',
          },
          payload: { sku: 'SKU-1' },
        });
      } finally {
        restarted.onModuleDestroy();
        await eventBus.onModuleDestroy();
        const streams = await redis.keys(`${namespace}:events:*`);
        if (streams.length > 0) await redis.del(...streams);
        await redis.quit();
        await database.onModuleDestroy();
      }
    },
  );

  it('dispatches scheduled workflows once per due interval', async () => {
    const runtime = new WorkflowRuntimeService();
    const workflow = await runtime.create({
      organizationId: 'org-schedules',
      name: 'scheduled',
      trigger: 'schedule',
      triggerConfig: { intervalSeconds: 60 },
      nodes: [{ id: 'done', kind: 'Condition', config: {} }],
      edges: [],
    });
    await runtime.publish('org-schedules', workflow.id);
    const now = new Date(Date.now() + 1_000);
    await expect(
      runtime.dispatchDueSchedules({
        organizationId: 'org-schedules',
        principalId: 'scheduler',
        now,
      }),
    ).resolves.toHaveLength(1);
    await expect(
      runtime.dispatchDueSchedules({
        organizationId: 'org-schedules',
        principalId: 'scheduler',
        now: new Date(now.getTime() + 30_000),
      }),
    ).resolves.toHaveLength(0);
    await expect(
      runtime.dispatchDueSchedules({
        organizationId: 'org-schedules',
        principalId: 'scheduler',
        now: new Date(now.getTime() + 61_000),
      }),
    ).resolves.toHaveLength(1);
  });

  it('creates and completes an asynchronous Operation for workflow execution', async () => {
    const eventBus = new EventBusRuntimeService();
    const operations = new OperationsRuntimeService(undefined, undefined, eventBus);
    let createdEvent: Record<string, unknown> | undefined;
    eventBus.subscribe('operation.created', (event) => {
      createdEvent = event as unknown as Record<string, unknown>;
      return Promise.resolve();
    });
    const runtime = new WorkflowRuntimeService(undefined, operations);
    const workflow = await runtime.create({
      organizationId: 'org-async',
      name: 'async workflow',
      trigger: 'api',
      nodes: [{ id: 'first', kind: 'Condition', config: {} }],
      edges: [],
    });
    await runtime.publish('org-async', workflow.id);

    const operation = await runtime.startAsync({
      organizationId: 'org-async',
      workflowId: workflow.id,
      principalId: 'user-async',
      trigger: 'api',
      payload: { async: true },
      idempotencyKey: 'workflow-operation-1',
      context: {
        requestId: 'request-workflow-1',
        traceId: 'trace-workflow-1',
        principalId: 'user-async',
        source: 'API',
      },
    });
    expect(operation).toMatchObject({ status: 'PENDING', type: `workflow:${workflow.id}` });
    expect(createdEvent).toMatchObject({
      causationId: 'request-workflow-1',
      context: {
        requestId: 'request-workflow-1',
        traceId: 'trace-workflow-1',
        principalId: 'user-async',
        source: 'API',
      },
    });
    const queue = operations.queue('workflow-executions', 'org-async');
    const processed = await queue.process(async () => Promise.resolve());
    const job = processed?.job;
    expect(job?.payload).toMatchObject({
      organizationId: 'org-async',
      operationId: operation.id,
      workflowId: workflow.id,
      context: {
        requestId: 'request-workflow-1',
        traceId: 'trace-workflow-1',
        principalId: 'user-async',
        source: 'API',
      },
    });
    if (job === undefined) throw new Error('workflow execution job was not queued');
    await runtime.executeQueued(job.payload as Parameters<typeof runtime.executeQueued>[0]);
    await expect(operations.getOperation('org-async', operation.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
    const completedOperation = await operations.getOperation('org-async', operation.id);
    const result = completedOperation?.result;
    const executionId =
      typeof result === 'object' && result !== null && 'executionId' in result
        ? result.executionId
        : undefined;
    expect(typeof executionId).toBe('string');
    await expect(runtime.getExecution('org-async', executionId as string)).resolves.toMatchObject({
      idempotencyKey: 'workflow-operation-1',
    });
  });

  it('propagates an already-aborted external signal to the asynchronous Operation', async () => {
    const operations = new OperationsRuntimeService();
    const runtime = new WorkflowRuntimeService(undefined, operations);
    const workflow = await runtime.create({
      organizationId: 'org-cancelled',
      name: 'cancelled workflow',
      trigger: 'api',
      nodes: [{ id: 'first', kind: 'Condition', config: {} }],
      edges: [],
    });
    await runtime.publish('org-cancelled', workflow.id);
    const signal = new AbortController();
    signal.abort();
    const operation = await runtime.startAsync({
      organizationId: 'org-cancelled',
      workflowId: workflow.id,
      principalId: 'user-cancelled',
      trigger: 'api',
      payload: null,
      idempotencyKey: 'workflow-operation-cancelled',
      signal: signal.signal,
    });
    expect(operation).toMatchObject({ status: 'CANCELLED', cancelRequested: true });
    await expect(operations.getOperation('org-cancelled', operation.id)).resolves.toEqual(
      operation,
    );
  });

  it('hydrates a persisted waiting execution in a new runtime instance', async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    const database = new DatabaseService();
    await database.onModuleInit();
    try {
      const first = new WorkflowRuntimeService(database);
      const workflow = await first.create({
        organizationId: 'org-recovery',
        name: 'approval',
        trigger: 'manual',
        nodes: [
          { id: 'approval', kind: 'Human Approval', config: { approvers: ['reviewer'] } },
          { id: 'done', kind: 'Condition', config: {} },
        ],
        edges: [{ from: 'approval', to: 'done' }],
      });
      await first.publish('org-recovery', workflow.id);
      const waiting = await first.start({
        organizationId: 'org-recovery',
        workflowId: workflow.id,
        principalId: 'requester',
        trigger: 'manual',
        payload: 'persisted',
      });

      const restarted = new WorkflowRuntimeService(database);
      await expect(restarted.listSteps('org-other', waiting.id)).rejects.toThrow(
        'Workflow execution not found',
      );
      await expect(restarted.listSteps('org-recovery', waiting.id)).resolves.toEqual([
        expect.objectContaining({ nodeId: 'approval', status: 'WAITING_APPROVAL' }),
      ]);
      await expect(
        restarted.approve({
          organizationId: 'org-other',
          executionId: waiting.id,
          approverId: 'reviewer',
        }),
      ).rejects.toThrow('Workflow execution not found');
      await expect(
        restarted.approve({
          organizationId: 'org-recovery',
          executionId: waiting.id,
          approverId: 'reviewer',
        }),
      ).resolves.toMatchObject({ status: 'COMPLETED', output: 'persisted' });
    } finally {
      await database.onModuleDestroy();
    }
  });
});
