import { Inject, Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { uuidV7 } from '@handstack/domain';
import {
  WorkflowRuntime,
  RepositoryWorkflowStore,
  type WorkflowStore,
  type Workflow,
  type WorkflowEdge,
  type WorkflowExecution,
  type WorkflowNode,
  type WorkflowStepExecution,
  type WorkflowTrigger,
} from '@handstack/workflows';
import { ValidationError } from '@handstack/shared';
import { OperationsRuntimeService } from '../operations/operations-runtime.service.js';

export interface WorkflowDefinitionInput {
  readonly organizationId: string;
  readonly name: string;
  readonly trigger: WorkflowTrigger;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

@Injectable()
export class WorkflowRuntimeService {
  private readonly workflows = new Map<string, Workflow>();
  private readonly store: WorkflowStore | undefined;
  private readonly runtime: WorkflowRuntime;

  constructor(
    @Optional() @Inject(DatabaseService) database?: DatabaseService,
    @Optional()
    @Inject(OperationsRuntimeService)
    private readonly operations?: OperationsRuntimeService,
  ) {
    this.store =
      database === undefined
        ? undefined
        : new RepositoryWorkflowStore((name) => database.adapter.repository(name));
    this.runtime = new WorkflowRuntime((node, input) => {
      // Core nodes are intentionally side-effect free here. Providers can replace this executor.
      if (node.kind === 'Condition' && typeof node.config.pass === 'boolean' && !node.config.pass)
        return Promise.resolve({ input, skipped: true });
      return Promise.resolve(input);
    }, this.store);
  }

  async list(organizationId: string): Promise<readonly Workflow[]> {
    const durable = (await this.store?.listWorkflows(organizationId)) ?? [];
    for (const workflow of durable) {
      this.workflows.set(this.key(organizationId, workflow.id), workflow);
      this.runtime.register(workflow);
    }
    return [...this.workflows.values()].filter(
      (workflow) => workflow.organizationId === organizationId,
    );
  }

  async get(organizationId: string, workflowId: string): Promise<Workflow> {
    const workflow = this.workflows.get(this.key(organizationId, workflowId));
    if (workflow?.organizationId === organizationId) return workflow;
    const durable = await this.store?.findWorkflow(organizationId, workflowId);
    if (durable === undefined) throw new ValidationError('Workflow not found');
    this.workflows.set(this.key(organizationId, workflowId), durable);
    this.runtime.register(durable);
    return durable;
  }

  async create(input: WorkflowDefinitionInput): Promise<Workflow> {
    const now = new Date();
    const workflow: Workflow = {
      id: uuidV7(),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      name: input.name,
      trigger: input.trigger,
      nodes: input.nodes,
      edges: input.edges,
      published: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.runtime.register(workflow);
    this.workflows.set(this.key(input.organizationId, workflow.id), workflow);
    await this.store?.saveWorkflow(workflow);
    return workflow;
  }

  async publish(organizationId: string, workflowId: string): Promise<Workflow> {
    const current = await this.get(organizationId, workflowId);
    const published: Workflow = { ...current, published: true, updatedAt: new Date() };
    this.runtime.register(published);
    this.workflows.set(this.key(organizationId, workflowId), published);
    await this.store?.saveWorkflow(published);
    return published;
  }

  start(input: {
    readonly organizationId: string;
    readonly workflowId: string;
    readonly principalId: string;
    readonly trigger: WorkflowTrigger;
    readonly payload: unknown;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkflowExecution> {
    return this.get(input.organizationId, input.workflowId).then(async () => {
      const execution = await this.runtime.start(input);
      return execution;
    });
  }

  async startAsync(input: {
    readonly organizationId: string;
    readonly workflowId: string;
    readonly principalId: string;
    readonly trigger: WorkflowTrigger;
    readonly payload: unknown;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }) {
    if (this.operations === undefined)
      throw new ValidationError('Operations runtime is required for asynchronous workflows');
    const operation = await this.operations.createOperation({
      organizationId: input.organizationId,
      type: `workflow:${input.workflowId}`,
      idempotencyKey: input.idempotencyKey,
    });
    if (operation.status !== 'PENDING') return operation;
    if (input.signal?.aborted) {
      try {
        return await this.operations.operations.update(
          { ...operation, status: 'CANCELLED', cancelRequested: true },
          operation.version,
        );
      } catch {
        return operation;
      }
    }
    let running: typeof operation;
    try {
      running = await this.operations.operations.update(
        { ...operation, status: 'RUNNING' },
        operation.version,
      );
    } catch {
      // A concurrent cancellation may have advanced the operation before work started.
      return operation;
    }
    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
    };
    if (input.signal?.aborted) controller.abort();
    else input.signal?.addEventListener('abort', onAbort, { once: true });
    const cancellationTimer = setInterval(() => {
      void this.operations?.getOperation(input.organizationId, running.id).then((current) => {
        if (current?.cancelRequested === true || current?.status === 'CANCELLED')
          controller.abort();
      });
    }, 50);
    void this.start({
      organizationId: input.organizationId,
      workflowId: input.workflowId,
      principalId: input.principalId,
      trigger: input.trigger,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      signal: controller.signal,
    })
      .then(async (execution) => {
        try {
          await this.operations?.operations.update(
            {
              ...running,
              status: controller.signal.aborted
                ? 'CANCELLED'
                : execution.status === 'COMPLETED'
                  ? 'SUCCEEDED'
                  : 'FAILED',
              ...(execution.status === 'COMPLETED'
                ? { result: { executionId: execution.id } }
                : { errorCode: execution.error ?? 'workflow_execution_failed' }),
            },
            running.version,
          );
        } catch {
          // A concurrent API cancellation already advanced the Operation version.
        }
      })
      .catch(async (error: unknown) => {
        try {
          await this.operations?.operations.update(
            {
              ...running,
              status: controller.signal.aborted ? 'CANCELLED' : 'FAILED',
              errorCode: controller.signal.aborted
                ? 'workflow_execution_cancelled'
                : error instanceof ValidationError
                  ? error.code
                  : 'workflow_execution_failed',
            },
            running.version,
          );
        } catch {
          // A concurrent API cancellation already advanced the Operation version.
        }
      })
      .finally(() => {
        clearInterval(cancellationTimer);
        input.signal?.removeEventListener('abort', onAbort);
      });
    return operation;
  }

  async getExecution(organizationId: string, executionId: string): Promise<WorkflowExecution> {
    const execution = this.runtime.get(organizationId, executionId);
    if (execution !== undefined) return execution;
    const durable = await this.store?.findExecution(organizationId, executionId);
    if (durable === undefined) throw new ValidationError('Workflow execution not found');
    const workflow = await this.get(organizationId, durable.workflowId);
    await this.runtime.hydrate(durable, workflow);
    return durable;
  }

  async listSteps(
    organizationId: string,
    executionId: string,
  ): Promise<readonly WorkflowStepExecution[]> {
    const execution = await this.getExecution(organizationId, executionId);
    const steps = await this.store?.listSteps(organizationId, execution.id);
    return steps ?? this.runtime.listSteps(organizationId, execution.id);
  }

  async approve(input: {
    readonly organizationId: string;
    readonly executionId: string;
    readonly approverId: string;
  }): Promise<WorkflowExecution> {
    const execution = await this.getExecution(input.organizationId, input.executionId);
    if (execution.status !== 'WAITING_APPROVAL' || execution.approvalId === undefined)
      throw new ValidationError('Workflow execution is not waiting for approval');
    await this.runtime.approve(input.organizationId, execution.approvalId, input.approverId);
    const resumed = await this.runtime.resume(
      input.organizationId,
      input.executionId,
      execution.approvalId,
    );
    return resumed;
  }

  async recover(input: {
    readonly organizationId: string;
    readonly executionId: string;
  }): Promise<WorkflowExecution> {
    const execution = await this.getExecution(input.organizationId, input.executionId);
    if (execution.status !== 'RUNNING' && execution.status !== 'FAILED')
      throw new ValidationError('Workflow execution is not recoverable');
    return this.runtime.recover(input.organizationId, input.executionId);
  }

  private key(organizationId: string, id: string): string {
    return `${organizationId}:${id}`;
  }
}
