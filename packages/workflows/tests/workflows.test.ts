import { describe, expect, it } from 'vitest';
import {
  RepositoryWorkflowStore,
  WorkflowRuntime,
  type WorkflowCompensation,
  type Workflow,
  type WorkflowExecution,
  type WorkflowStepExecution,
  type WorkflowStore,
} from '../src/index.js';
import type { Page, PageRequest, Repository, TenantEntity } from '@handstack/domain';

class FakeRepository<T extends TenantEntity> implements Repository<T> {
  private readonly values = new Map<string, T>();
  findById(tenantId: string, id: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(`${tenantId}:${id}`));
  }
  list(tenantId: string, page: PageRequest): Promise<Page<T>> {
    const all = [...this.values.values()]
      .filter((value) => value.tenantId === tenantId)
      .sort((left, right) => left.id.localeCompare(right.id));
    const start = page.cursor === undefined ? 0 : Number(page.cursor);
    const items = all.slice(start, start + page.limit);
    return Promise.resolve({
      items,
      ...(start + page.limit < all.length ? { nextCursor: String(start + page.limit) } : {}),
    });
  }
  insert(entity: T): Promise<T> {
    this.values.set(`${entity.tenantId}:${entity.id}`, entity);
    return Promise.resolve(entity);
  }
  update(entity: T, expectedVersion: number): Promise<T> {
    const current = this.values.get(`${entity.tenantId}:${entity.id}`);
    if (current?.version !== expectedVersion) return Promise.reject(new Error('conflict'));
    this.values.set(`${entity.tenantId}:${entity.id}`, entity);
    return Promise.resolve(entity);
  }
  delete(tenantId: string, id: string, expectedVersion: number): Promise<boolean> {
    const current = this.values.get(`${tenantId}:${id}`);
    return Promise.resolve(
      current?.version === expectedVersion && this.values.delete(`${tenantId}:${id}`),
    );
  }
}

const workflow: Workflow = {
  id: 'flow',
  tenantId: 'org',
  organizationId: 'org',
  name: 'flow',
  trigger: 'manual',
  published: true,
  version: 1,
  nodes: [
    { id: 'a', kind: 'Capability', config: {} },
    { id: 'b', kind: 'Human Approval', config: { approvers: ['admin'] } },
    { id: 'c', kind: 'Tool', config: {} },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Workflow runtime', () => {
  it('materializes version, trigger and compensation entities in the durable store', async () => {
    const repositories = new Map<string, FakeRepository<TenantEntity>>();
    const store = new RepositoryWorkflowStore((name) => {
      const key = String(name);
      const existing = repositories.get(key);
      if (existing !== undefined) return existing as never;
      const created = new FakeRepository<TenantEntity>();
      repositories.set(key, created);
      return created as never;
    });
    const versioned: Workflow = {
      ...workflow,
      id: 'versioned-flow',
      nodes: [
        {
          id: 'step',
          kind: 'Tool',
          config: {},
          compensation: { kind: 'Capability', config: { slug: 'undo.step' } },
        },
      ],
      edges: [],
    };
    await store.saveWorkflow(versioned);
    expect(
      (await repositories.get('workflow-versions')?.list('org', { limit: 10 }))?.items,
    ).toHaveLength(1);
    expect(
      (await repositories.get('workflow-triggers')?.list('org', { limit: 10 }))?.items,
    ).toHaveLength(1);
    const compensations = (
      await repositories.get('workflow-compensations')?.list('org', { limit: 10 })
    )?.items as WorkflowCompensation[] | undefined;
    expect(compensations).toMatchObject([
      { workflowId: 'versioned-flow', nodeId: 'step', kind: 'Capability' },
    ]);
  });

  it('runs compensations in reverse completion order when a later step fails', async () => {
    const compensated: string[] = [];
    const runtime = new WorkflowRuntime(
      (node, input) =>
        node.id === 'fail' ? Promise.reject(new Error('failure')) : Promise.resolve(input),
      undefined,
      (compensation, input) => {
        compensated.push(
          `${compensation.nodeId}:${String((input as { value?: string }).value ?? input)}`,
        );
        return Promise.resolve();
      },
    );
    runtime.register({
      ...workflow,
      id: 'compensating-flow',
      nodes: [
        { id: 'first', kind: 'Tool', config: {}, compensation: { kind: 'Tool', config: {} } },
        { id: 'second', kind: 'Tool', config: {}, compensation: { kind: 'Tool', config: {} } },
        { id: 'fail', kind: 'Tool', config: {} },
      ],
      edges: [
        { from: 'first', to: 'second' },
        { from: 'second', to: 'fail' },
      ],
    });
    const result = await runtime.start({
      organizationId: 'org',
      workflowId: 'compensating-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: { value: 'input' },
    });
    expect(result.status).toBe('FAILED');
    expect(compensated.map((value) => value.split(':')[0])).toEqual(['second', 'first']);
  });

  it('deduplicates a repeated execution idempotency key and rejects request reuse', async () => {
    let executions = 0;
    const runtime = new WorkflowRuntime((_node, input) => {
      executions += 1;
      return Promise.resolve(input);
    });
    runtime.register({
      ...workflow,
      id: 'idempotent-flow',
      nodes: [{ id: 'run', kind: 'Tool', config: {} }],
      edges: [],
    });
    runtime.register({
      ...workflow,
      id: 'idempotent-api-flow',
      trigger: 'api',
      nodes: [{ id: 'run', kind: 'Tool', config: {} }],
      edges: [],
    });
    const first = await runtime.start({
      organizationId: 'org',
      workflowId: 'idempotent-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: { value: 1 },
      idempotencyKey: ' request-1 ',
    });
    const repeated = await runtime.start({
      organizationId: 'org',
      workflowId: 'idempotent-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: first.input,
      idempotencyKey: 'request-1',
    });
    expect(repeated.id).toBe(first.id);
    expect(executions).toBe(1);
    await expect(
      runtime.start({
        organizationId: 'org',
        workflowId: 'idempotent-flow',
        principalId: 'user',
        trigger: 'manual',
        payload: { value: 2 },
        idempotencyKey: 'request-1',
      }),
    ).rejects.toThrow(/already been used/);
    await expect(
      runtime.start({
        organizationId: 'org',
        workflowId: 'idempotent-api-flow',
        principalId: 'user',
        trigger: 'api',
        payload: { value: 1 },
        idempotencyKey: 'request-1',
      }),
    ).rejects.toThrow(/already been used/);
  });

  it('deduplicates concurrent starts with the same idempotency key', async () => {
    let executions = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new WorkflowRuntime(async (_node, input) => {
      executions += 1;
      await gate;
      return input;
    });
    runtime.register({
      ...workflow,
      id: 'concurrent-idempotent-flow',
      nodes: [{ id: 'run', kind: 'Tool', config: {} }],
      edges: [],
    });
    const first = runtime.start({
      organizationId: 'org',
      workflowId: 'concurrent-idempotent-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: { value: 1 },
      idempotencyKey: 'concurrent-request',
    });
    const second = runtime.start({
      organizationId: 'org',
      workflowId: 'concurrent-idempotent-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: { value: 1 },
      idempotencyKey: 'concurrent-request',
    });
    release?.();
    const [left, right] = await Promise.all([first, second]);
    expect(left.id).toBe(right.id);
    expect(executions).toBe(1);
  });

  it('persists every execution and step checkpoint when a durable store is provided', async () => {
    const executions: WorkflowExecution[] = [];
    const steps: WorkflowStepExecution[] = [];
    const store: WorkflowStore = {
      saveWorkflow: (value) => Promise.resolve(value),
      listWorkflows: () => Promise.resolve([]),
      findWorkflow: () => Promise.resolve(undefined),
      saveExecution: (value) => {
        executions.push(value);
        return Promise.resolve(value);
      },
      findExecution: () => Promise.resolve(undefined),
      saveStep: (value) => {
        steps.push(value);
        return Promise.resolve(value);
      },
      listSteps: () => Promise.resolve(steps),
    };
    const runtime = new WorkflowRuntime(
      (_node, input) => Promise.resolve(`${String(input)}!`),
      store,
    );
    runtime.register(workflow);
    const waiting = await runtime.start({
      organizationId: 'org',
      workflowId: 'flow',
      principalId: 'user',
      trigger: 'manual',
      payload: 'checkpoint',
    });
    expect(waiting.status).toBe('WAITING_APPROVAL');
    expect(executions.map((value) => value.status)).toEqual([
      'RUNNING',
      'RUNNING',
      'RUNNING',
      'RUNNING',
      'WAITING_APPROVAL',
    ]);
    expect(steps.map((value) => value.status)).toEqual([
      'RUNNING',
      'COMPLETED',
      'RUNNING',
      'WAITING_APPROVAL',
    ]);
    expect(steps.every((step) => step.idempotencyKey.startsWith(`${waiting.id}:`))).toBe(true);
    // A same step is checkpointed in RUNNING and then terminal state with one stable
    // idempotency key; uniqueness must be asserted per distinct step, not per write.
    const distinctSteps = [...new Map(steps.map((step) => [step.id, step])).values()];
    expect(new Set(distinctSteps.map((step) => step.idempotencyKey)).size).toBe(
      distinctSteps.length,
    );
  });

  it('marks the active step as failed when node execution throws', async () => {
    const steps: WorkflowStepExecution[] = [];
    const executions: WorkflowExecution[] = [];
    const store: WorkflowStore = {
      saveWorkflow: (value) => Promise.resolve(value),
      listWorkflows: () => Promise.resolve([]),
      findWorkflow: () => Promise.resolve(undefined),
      saveExecution: (value) => {
        executions.push(value);
        return Promise.resolve(value);
      },
      findExecution: () => Promise.resolve(undefined),
      saveStep: (value) => {
        steps.push(value);
        return Promise.resolve(value);
      },
      listSteps: () => Promise.resolve(steps),
    };
    const runtime = new WorkflowRuntime(() => Promise.reject(new Error('node failed')), store);
    runtime.register({
      ...workflow,
      id: 'failing-flow',
      nodes: [{ id: 'fail', kind: 'Tool', config: {} }],
      edges: [],
    });
    const failed = await runtime.start({
      organizationId: 'org',
      workflowId: 'failing-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: 'failure',
    });
    expect(failed).toMatchObject({ status: 'FAILED', error: 'node failed' });
    expect(steps.map((value) => value.status)).toEqual(['RUNNING', 'FAILED']);
    expect(executions.map((value) => value.status)).toEqual(['RUNNING', 'RUNNING', 'FAILED']);
  });

  it('marks the active step and execution as cancelled when the signal aborts', async () => {
    const steps: WorkflowStepExecution[] = [];
    const executions: WorkflowExecution[] = [];
    const store: WorkflowStore = {
      saveWorkflow: (value) => Promise.resolve(value),
      listWorkflows: () => Promise.resolve([]),
      findWorkflow: () => Promise.resolve(undefined),
      saveExecution: (value) => {
        executions.push(value);
        return Promise.resolve(value);
      },
      findExecution: () => Promise.resolve(undefined),
      saveStep: (value) => {
        steps.push(value);
        return Promise.resolve(value);
      },
      listSteps: () => Promise.resolve(steps),
    };
    const controller = new AbortController();
    const runtime = new WorkflowRuntime(
      (_node, _input, context) =>
        new Promise<unknown>((_resolve, reject) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'));
            },
            {
              once: true,
            },
          );
        }),
      store,
    );
    runtime.register({
      ...workflow,
      id: 'cancelled-flow',
      nodes: [{ id: 'cancel', kind: 'Tool', config: {} }],
      edges: [],
    });
    const pending = runtime.start({
      organizationId: 'org',
      workflowId: 'cancelled-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: 'cancel',
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      status: 'CANCELLED',
      error: 'workflow_execution_cancelled',
    });
    expect(steps.map((value) => value.status)).toEqual(['RUNNING', 'CANCELLED']);
    expect(executions.at(-1)?.status).toBe('CANCELLED');
  });

  it('persists workflows and executions through canonical repositories', async () => {
    const repositories = new Map<string, FakeRepository<TenantEntity>>();
    const store = new RepositoryWorkflowStore(<T extends TenantEntity>(name: string) => {
      let repository = repositories.get(name);
      if (repository === undefined) {
        repository = new FakeRepository<TenantEntity>();
        repositories.set(name, repository);
      }
      return repository as unknown as Repository<T>;
    });
    await store.saveWorkflow(workflow);
    expect(await store.findWorkflow('org', 'flow')).toMatchObject({
      id: 'flow',
      organizationId: 'org',
    });
  });

  it('lists only the requested tenant execution step history', async () => {
    const repositories = new Map<string, FakeRepository<TenantEntity>>();
    const store = new RepositoryWorkflowStore(<T extends TenantEntity>(name: string) => {
      let repository = repositories.get(name);
      if (repository === undefined) {
        repository = new FakeRepository<TenantEntity>();
        repositories.set(name, repository);
      }
      return repository as unknown as Repository<T>;
    });
    const step = (id: string, tenantId: string, executionId: string): WorkflowStepExecution => ({
      id,
      tenantId,
      organizationId: tenantId,
      executionId,
      nodeId: 'node',
      idempotencyKey: `${executionId}:node:0`,
      status: 'COMPLETED',
      input: null,
      version: 1,
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await store.saveStep(step('step-a', 'org', 'execution-a'));
    await store.saveStep(step('step-b', 'org', 'execution-b'));
    await store.saveStep(step('step-c', 'other-org', 'execution-a'));
    await expect(store.listSteps('org', 'execution-a')).resolves.toMatchObject([
      { id: 'step-a', executionId: 'execution-a' },
    ]);
  });

  it('lists more than one repository page without exceeding the canonical limit', async () => {
    const repositories = new Map<string, FakeRepository<TenantEntity>>();
    const store = new RepositoryWorkflowStore(<T extends TenantEntity>(name: string) => {
      let repository = repositories.get(name);
      if (repository === undefined) {
        repository = new FakeRepository<TenantEntity>();
        repositories.set(name, repository);
      }
      return repository as unknown as Repository<T>;
    });
    for (let index = 0; index < 205; index += 1) {
      await store.saveWorkflow({ ...workflow, id: `flow-${String(index).padStart(3, '0')}` });
    }
    await expect(store.listWorkflows('org')).resolves.toHaveLength(205);
  });

  it('persists a waiting approval execution and resumes after approval', async () => {
    const runtime = new WorkflowRuntime((_node, input) => Promise.resolve(`${String(input)}!`));
    runtime.register(workflow);
    const waiting = await runtime.start({
      organizationId: 'org',
      workflowId: 'flow',
      principalId: 'user',
      trigger: 'manual',
      payload: 'start',
    });
    expect(waiting.status).toBe('WAITING_APPROVAL');
    expect(waiting.approvalId).toBeDefined();
    expect(runtime.get('org', waiting.id)?.status).toBe('WAITING_APPROVAL');
    const approvalId = waiting.approvalId;
    if (approvalId === undefined) throw new Error('approval id missing');
    await runtime.approve('org', approvalId, 'admin');
    await expect(runtime.resume('org', waiting.id, approvalId)).resolves.toMatchObject({
      status: 'COMPLETED',
      output: 'start!',
    });
  });

  it('does not resume an execution with another approved tenant approval', async () => {
    const runtime = new WorkflowRuntime((_node, input) => Promise.resolve(`${String(input)}!`));
    runtime.register({
      ...workflow,
      id: 'approval-isolation-flow',
      nodes: [{ id: 'approval', kind: 'Human Approval', config: { approvers: ['admin'] } }],
      edges: [],
    });
    const first = await runtime.start({
      organizationId: 'org',
      workflowId: 'approval-isolation-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: 'first',
    });
    const second = await runtime.start({
      organizationId: 'org',
      workflowId: 'approval-isolation-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: 'second',
    });
    if (first.approvalId === undefined || second.approvalId === undefined)
      throw new Error('approval id missing');
    await runtime.approve('org', second.approvalId, 'admin');
    await expect(runtime.resume('org', first.id, second.approvalId)).rejects.toThrow(
      /does not belong/,
    );
  });

  it('selects an approval continuation using deterministic edge conditions', async () => {
    const visited: string[] = [];
    const runtime = new WorkflowRuntime((node, input) => {
      visited.push(node.id);
      return Promise.resolve(input);
    });
    runtime.register({
      ...workflow,
      id: 'conditional-approval-flow',
      nodes: [
        { id: 'approval', kind: 'Human Approval', config: { approvers: ['admin'] } },
        { id: 'fallback', kind: 'Tool', config: {} },
        { id: 'continue', kind: 'Tool', config: {} },
      ],
      edges: [
        { from: 'approval', to: 'fallback', condition: 'false' },
        { from: 'approval', to: 'continue', condition: 'output.exists' },
      ],
    });
    const waiting = await runtime.start({
      organizationId: 'org',
      workflowId: 'conditional-approval-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: 'input',
    });
    if (waiting.approvalId === undefined) throw new Error('approval id missing');
    await runtime.approve('org', waiting.approvalId, 'admin');
    await expect(runtime.resume('org', waiting.id, waiting.approvalId)).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    expect(visited).toEqual(['continue']);
  });

  it('allows only bounded explicit loop nodes', async () => {
    const visited: string[] = [];
    const runtime = new WorkflowRuntime((node, input) => {
      visited.push(node.id);
      return Promise.resolve(node.kind === 'Loop' ? Number(input) + 1 : input);
    });
    runtime.register({
      ...workflow,
      id: 'bounded-loop-flow',
      nodes: [
        { id: 'loop', kind: 'Loop', config: { maxIterations: 3 } },
        { id: 'done', kind: 'Tool', config: {} },
      ],
      edges: [
        { from: 'loop', to: 'loop', condition: 'output != 3' },
        { from: 'loop', to: 'done', condition: 'output == 3' },
      ],
    });
    await expect(
      runtime.start({
        organizationId: 'org',
        workflowId: 'bounded-loop-flow',
        principalId: 'user',
        trigger: 'manual',
        payload: 0,
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED', output: 3 });
    expect(visited).toEqual(['loop', 'loop', 'loop', 'done']);
  });

  it('preserves loop iteration limits across recovery checkpoints', async () => {
    const repositories = new Map<string, FakeRepository<TenantEntity>>();
    const store = new RepositoryWorkflowStore(<T extends TenantEntity>(name: string) => {
      let repository = repositories.get(name);
      if (repository === undefined) {
        repository = new FakeRepository<TenantEntity>();
        repositories.set(name, repository);
      }
      return repository as unknown as Repository<T>;
    });
    const loopWorkflow: Workflow = {
      ...workflow,
      id: 'recoverable-loop-flow',
      nodes: [
        { id: 'loop', kind: 'Loop', config: { maxIterations: 3 } },
        { id: 'done', kind: 'Tool', config: {} },
      ],
      edges: [
        { from: 'loop', to: 'loop', condition: 'output != 3' },
        { from: 'loop', to: 'done', condition: 'output == 3' },
      ],
    };
    const execution: WorkflowExecution = {
      id: 'recoverable-loop-execution',
      tenantId: 'org',
      organizationId: 'org',
      workflowId: loopWorkflow.id,
      principalId: 'user',
      status: 'RUNNING',
      input: 2,
      currentNodeId: 'loop',
      loopIterations: { loop: 2 },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await store.saveWorkflow(loopWorkflow);
    await store.saveExecution(execution);
    await store.saveStep({
      id: 'loop-checkpoint',
      tenantId: 'org',
      organizationId: 'org',
      executionId: execution.id,
      nodeId: 'loop',
      idempotencyKey: `${execution.id}:loop:1`,
      status: 'COMPLETED',
      input: 1,
      output: 2,
      startedAt: new Date(1),
      completedAt: new Date(2),
      version: 1,
      createdAt: new Date(1),
      updatedAt: new Date(2),
    });
    const restarted = new WorkflowRuntime(
      (node, input) => Promise.resolve(node.kind === 'Loop' ? Number(input) + 1 : input),
      store,
    );
    restarted.register(loopWorkflow);
    await restarted.hydrate(execution, loopWorkflow);
    await expect(restarted.recover('org', execution.id)).resolves.toMatchObject({
      status: 'COMPLETED',
      output: 3,
    });
  });

  it('recovers a running execution from a durable checkpoint after restart', async () => {
    const repositories = new Map<string, FakeRepository<TenantEntity>>();
    const store = new RepositoryWorkflowStore(<T extends TenantEntity>(name: string) => {
      let repository = repositories.get(name);
      if (repository === undefined) {
        repository = new FakeRepository<TenantEntity>();
        repositories.set(name, repository);
      }
      return repository as unknown as Repository<T>;
    });
    await store.saveWorkflow(workflow);
    const execution: WorkflowExecution = {
      id: 'recovery-execution',
      tenantId: 'org',
      organizationId: 'org',
      workflowId: workflow.id,
      principalId: 'user',
      status: 'RUNNING',
      input: 'recovered',
      currentNodeId: 'a',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await store.saveExecution(execution);
    const restarted = new WorkflowRuntime(
      (_node, input) => Promise.resolve(`${String(input)}!`),
      store,
    );
    restarted.register(workflow);
    await restarted.hydrate(execution, workflow);
    await expect(restarted.recover('other-org', execution.id)).rejects.toThrow(/recoverable/);
    await expect(restarted.recover('org', execution.id)).resolves.toMatchObject({
      status: 'WAITING_APPROVAL',
      currentNodeId: 'b',
    });
  });

  it('resumes from the last completed checkpoint value after a node failure', async () => {
    const steps: WorkflowStepExecution[] = [
      {
        id: 'completed-step',
        tenantId: 'org',
        organizationId: 'org',
        executionId: 'checkpoint-execution',
        nodeId: 'a',
        idempotencyKey: 'checkpoint-execution:a:0',
        status: 'COMPLETED',
        input: 'original',
        output: 'checkpoint-value',
        startedAt: new Date(1),
        completedAt: new Date(2),
        version: 1,
        createdAt: new Date(1),
        updatedAt: new Date(2),
      },
      {
        id: 'completed-step-with-empty-output',
        tenantId: 'org',
        organizationId: 'org',
        executionId: 'checkpoint-execution',
        nodeId: 'b',
        idempotencyKey: 'checkpoint-execution:b:0',
        status: 'COMPLETED',
        input: 'checkpoint-value',
        output: undefined,
        startedAt: new Date(3),
        completedAt: new Date(4),
        version: 1,
        createdAt: new Date(3),
        updatedAt: new Date(4),
      },
    ];
    const execution: WorkflowExecution = {
      id: 'checkpoint-execution',
      tenantId: 'org',
      organizationId: 'org',
      workflowId: 'recover-flow',
      principalId: 'user',
      status: 'RUNNING',
      input: 'original',
      currentNodeId: 'c',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const store: WorkflowStore = {
      saveWorkflow: (value) => Promise.resolve(value),
      listWorkflows: () => Promise.resolve([]),
      findWorkflow: () => Promise.resolve(undefined),
      saveExecution: (value) => Promise.resolve(value),
      findExecution: () => Promise.resolve(undefined),
      saveStep: (value) => Promise.resolve(value),
      listSteps: () => Promise.resolve(steps),
    };
    const seen: unknown[] = [];
    const runtime = new WorkflowRuntime((_node, input) => {
      seen.push(input);
      return Promise.resolve(input);
    }, store);
    runtime.register({
      ...workflow,
      id: 'recover-flow',
      nodes: workflow.nodes,
      edges: workflow.edges,
    });
    await runtime.hydrate(execution, {
      ...workflow,
      id: 'recover-flow',
      nodes: workflow.nodes,
      edges: workflow.edges,
    });

    await expect(runtime.recover('org', execution.id)).resolves.toMatchObject({
      status: 'COMPLETED',
      output: undefined,
    });
    expect(seen).toEqual([undefined]);
  });

  it('recovers a persisted failed execution after a node failure', async () => {
    const execution: WorkflowExecution = {
      id: 'failed-recovery-execution',
      tenantId: 'org',
      organizationId: 'org',
      workflowId: 'failed-recovery-flow',
      principalId: 'user',
      status: 'FAILED',
      input: 'original',
      currentNodeId: 'a',
      error: 'temporary node failure',
      version: 2,
      createdAt: new Date(1),
      updatedAt: new Date(2),
    };
    const store: WorkflowStore = {
      saveWorkflow: (value) => Promise.resolve(value),
      listWorkflows: () => Promise.resolve([]),
      findWorkflow: () => Promise.resolve(undefined),
      saveExecution: (value) => Promise.resolve(value),
      findExecution: () => Promise.resolve(undefined),
      saveStep: (value) => Promise.resolve(value),
      listSteps: () => Promise.resolve([]),
    };
    const runtime = new WorkflowRuntime(
      (_node, input) => Promise.resolve(`${String(input)}!`),
      store,
    );
    const failedWorkflow = {
      ...workflow,
      id: 'failed-recovery-flow',
      nodes: [{ id: 'a', kind: 'Capability' as const, config: {} }],
      edges: [],
    };
    runtime.register(failedWorkflow);
    await runtime.hydrate(execution, failedWorkflow);

    await expect(runtime.recover('org', execution.id)).resolves.toMatchObject({
      status: 'COMPLETED',
      output: 'original!',
    });
  });

  it('rejects unpublished or wrong-trigger starts', async () => {
    const runtime = new WorkflowRuntime((_node, input) => Promise.resolve(input));
    runtime.register({ ...workflow, id: 'draft', published: false });
    runtime.register(workflow);
    await expect(
      runtime.start({
        organizationId: 'org',
        workflowId: 'draft',
        principalId: 'u',
        trigger: 'manual',
        payload: {},
      }),
    ).rejects.toThrow(/published/);
    await expect(
      runtime.start({
        organizationId: 'org',
        workflowId: 'flow',
        principalId: 'u',
        trigger: 'api',
        payload: {},
      }),
    ).rejects.toThrow(/published/);
  });

  it('rejects cyclic workflow graphs before registration', () => {
    const runtime = new WorkflowRuntime((_node, input) => Promise.resolve(input));
    expect(() => {
      runtime.register({
        ...workflow,
        id: 'cyclic-flow',
        nodes: [
          { id: 'first', kind: 'Capability', config: {} },
          { id: 'second', kind: 'Tool', config: {} },
        ],
        edges: [
          { from: 'first', to: 'second' },
          { from: 'second', to: 'first' },
        ],
      });
    }).toThrow(/cycle/);
  });

  it('selects the first outgoing edge whose deterministic condition matches', async () => {
    const visited: string[] = [];
    const runtime = new WorkflowRuntime((node, input) => {
      visited.push(node.id);
      return Promise.resolve(input);
    });
    runtime.register({
      ...workflow,
      id: 'conditional-flow',
      nodes: [
        { id: 'start', kind: 'Condition', config: {} },
        { id: 'fallback', kind: 'Tool', config: {} },
        { id: 'matched', kind: 'Tool', config: {} },
      ],
      edges: [
        { from: 'start', to: 'fallback', condition: 'output == "no"' },
        { from: 'start', to: 'matched', condition: 'output == "yes"' },
      ],
    });
    await expect(
      runtime.start({
        organizationId: 'org',
        workflowId: 'conditional-flow',
        principalId: 'user',
        trigger: 'manual',
        payload: 'yes',
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED', output: 'yes' });
    expect(visited).toEqual(['start', 'matched']);
  });

  it('does not replace a published graph with a changed definition', () => {
    const runtime = new WorkflowRuntime((_node, input) => Promise.resolve(input));
    runtime.register(workflow);
    expect(() => {
      runtime.register({
        ...workflow,
        nodes: [{ id: 'changed', kind: 'Capability', config: {} }],
        edges: [],
      });
    }).toThrow(/immutable/);
  });

  it('rejects definitions whose tenant and organization or node identity do not match', () => {
    const runtime = new WorkflowRuntime((_node, input) => Promise.resolve(input));
    expect(() => {
      runtime.register({ ...workflow, tenantId: 'other-org' });
    }).toThrow(/organization and nodes/);
    expect(() => {
      runtime.register({
        ...workflow,
        nodes: [{ id: '', kind: 'Capability', config: {} }],
        edges: [],
      });
    }).toThrow(/graph/);
  });

  it('rejects human approval nodes without required approvers', () => {
    const runtime = new WorkflowRuntime((_node, input) => Promise.resolve(input));
    expect(() => {
      runtime.register({
        ...workflow,
        id: 'approval-without-approvers',
        nodes: [{ id: 'approval', kind: 'Human Approval', config: {} }],
        edges: [],
      });
    }).toThrow(/approvers/);
  });

  it('times out a step and propagates cancellation to its executor', async () => {
    let aborted = false;
    const runtime = new WorkflowRuntime((node, _input, context) => {
      expect(node.config.timeoutMs).toBe(10);
      return new Promise<unknown>((_resolve, reject) => {
        context.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('aborted by timeout'));
          },
          { once: true },
        );
      });
    });
    runtime.register({
      ...workflow,
      id: 'timed-out-flow',
      nodes: [{ id: 'slow', kind: 'Tool', config: { timeoutMs: 10 } }],
      edges: [],
    });
    await expect(
      runtime.start({
        organizationId: 'org',
        workflowId: 'timed-out-flow',
        principalId: 'user',
        trigger: 'manual',
        payload: null,
      }),
    ).resolves.toMatchObject({ status: 'TIMED_OUT', error: 'workflow_step_timeout' });
    expect(aborted).toBe(true);
  });

  it('propagates trigger provenance into workflow node execution', async () => {
    let received: { requestId?: string; traceId?: string; source?: string } | undefined;
    const runtime = new WorkflowRuntime((_node, _input, context) => {
      received = context;
      return Promise.resolve('done');
    });
    runtime.register({
      ...workflow,
      id: 'provenance-flow',
      trigger: 'api',
      published: true,
      nodes: [{ id: 'step', kind: 'Tool', config: {} }],
      edges: [],
    });

    await expect(
      runtime.start({
        organizationId: 'org',
        workflowId: 'provenance-flow',
        principalId: 'user',
        trigger: 'api',
        payload: null,
        context: { requestId: 'req-1', traceId: 'trace-1', source: 'API' },
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(received).toMatchObject({ requestId: 'req-1', traceId: 'trace-1', source: 'API' });
  });

  it('fails a step when its serialized output exceeds the configured limit', async () => {
    const runtime = new WorkflowRuntime(() => Promise.resolve('output-too-large'));
    runtime.register({
      ...workflow,
      id: 'bounded-output-flow',
      nodes: [{ id: 'bounded', kind: 'Tool', config: { maxOutputBytes: 5 } }],
      edges: [],
    });
    await expect(
      runtime.start({
        organizationId: 'org',
        workflowId: 'bounded-output-flow',
        principalId: 'user',
        trigger: 'manual',
        payload: null,
      }),
    ).resolves.toMatchObject({ status: 'FAILED', error: 'workflow_output_too_large' });
  });

  it('redacts serialization failures for unsupported workflow outputs', async () => {
    const runtime = new WorkflowRuntime(() => Promise.resolve(1n));
    runtime.register({
      ...workflow,
      id: 'invalid-output-flow',
      nodes: [{ id: 'invalid', kind: 'Tool', config: { maxOutputBytes: 100 } }],
      edges: [],
    });
    await expect(
      runtime.start({
        organizationId: 'org',
        workflowId: 'invalid-output-flow',
        principalId: 'user',
        trigger: 'manual',
        payload: null,
      }),
    ).resolves.toMatchObject({ status: 'FAILED', error: 'workflow_output_invalid' });
  });

  it('retries a failed step within its bounded retry policy', async () => {
    let attempts = 0;
    const runtime = new WorkflowRuntime((_node, input) => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('transient'))
        : Promise.resolve(`${String(input)} recovered`);
    });
    runtime.register({
      ...workflow,
      id: 'retry-flow',
      nodes: [{ id: 'retry', kind: 'Tool', config: { retry: { maxAttempts: 2 } } }],
      edges: [],
    });
    await expect(
      runtime.start({
        organizationId: 'org',
        workflowId: 'retry-flow',
        principalId: 'user',
        trigger: 'manual',
        payload: 'input',
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED', output: 'input recovered' });
    expect(attempts).toBe(2);
  });

  it('does not start another retry after cancellation during backoff', async () => {
    let attempts = 0;
    const controller = new AbortController();
    const runtime = new WorkflowRuntime(() => {
      attempts += 1;
      return Promise.reject(new Error('transient'));
    });
    runtime.register({
      ...workflow,
      id: 'cancelled-retry-flow',
      nodes: [{ id: 'retry', kind: 'Tool', config: { retry: { maxAttempts: 3, backoffMs: 25 } } }],
      edges: [],
    });
    const pending = runtime.start({
      organizationId: 'org',
      workflowId: 'cancelled-retry-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: null,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 5);
    await expect(pending).resolves.toMatchObject({
      status: 'CANCELLED',
      error: 'workflow_execution_cancelled',
    });
    expect(attempts).toBe(1);
  });

  it('interrupts a long retry backoff when cancellation is requested', async () => {
    const controller = new AbortController();
    const runtime = new WorkflowRuntime(() => Promise.reject(new Error('transient')));
    runtime.register({
      ...workflow,
      id: 'interruptible-retry-flow',
      nodes: [
        {
          id: 'retry',
          kind: 'Tool',
          config: { retry: { maxAttempts: 3, backoffMs: 1_000 } },
        },
      ],
      edges: [],
    });
    const startedAt = Date.now();
    const pending = runtime.start({
      organizationId: 'org',
      workflowId: 'interruptible-retry-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: null,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 5);
    await expect(pending).resolves.toMatchObject({
      status: 'CANCELLED',
      error: 'workflow_execution_cancelled',
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('reports cancellation when an external abort follows a timed-out attempt', async () => {
    const controller = new AbortController();
    const runtime = new WorkflowRuntime(
      (_node, _input, context) =>
        new Promise<unknown>((_resolve, reject) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'));
            },
            {
              once: true,
            },
          );
        }),
    );
    runtime.register({
      ...workflow,
      id: 'timeout-then-cancel-flow',
      nodes: [
        {
          id: 'slow',
          kind: 'Tool',
          config: { timeoutMs: 5, retry: { maxAttempts: 2, backoffMs: 25 } },
        },
      ],
      edges: [],
    });
    const pending = runtime.start({
      organizationId: 'org',
      workflowId: 'timeout-then-cancel-flow',
      principalId: 'user',
      trigger: 'manual',
      payload: null,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 10);
    await expect(pending).resolves.toMatchObject({
      status: 'CANCELLED',
      error: 'workflow_execution_cancelled',
    });
  });
});
