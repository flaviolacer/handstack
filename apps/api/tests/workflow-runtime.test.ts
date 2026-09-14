import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { OperationsRuntimeService } from '../src/operations/operations-runtime.service.js';
import { WorkflowRuntimeService } from '../src/workflows/workflow-runtime.service.js';

afterEach(() => {
  delete process.env.HANDSTACK_DATABASE_ADAPTER;
  delete process.env.HANDSTACK_DATABASE_URL;
});

describe('WorkflowRuntimeService', () => {
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

  it('creates and completes an asynchronous Operation for workflow execution', async () => {
    const operations = new OperationsRuntimeService();
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
    });
    expect(operation).toMatchObject({ status: 'PENDING', type: `workflow:${workflow.id}` });

    await new Promise((resolve) => setTimeout(resolve, 0));
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
