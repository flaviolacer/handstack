import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { repositoryName, uuidV7 } from '@handstack/domain';
import {
  WorkflowRuntime,
  RepositoryWorkflowStore,
  type WorkflowStore,
  type Workflow,
  type WorkflowEdge,
  type WorkflowExecution,
  type WorkflowExecutionContext,
  type WorkflowNode,
  type WorkflowStepExecution,
  type WorkflowTrigger,
  type CompensationProvider,
} from '@handstack/workflows';
import { ValidationError } from '@handstack/shared';
import { OperationsRuntimeService } from '../operations/operations-runtime.service.js';
import { AgentRuntimeService } from '../agents/agent-runtime.service.js';
import { CapabilityRuntimeService } from '../capabilities/capability-runtime.service.js';
import { ModelAdminRuntimeService } from '../models/model-admin-runtime.service.js';
import { McpRuntimeService } from '../mcp/mcp-runtime.service.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import type { DomainEvent, DomainEventContext } from '@handstack/core';
import { EventBusRuntimeService } from '../core/event-bus-runtime.service.js';
import type { Organization } from '@handstack/identity';

export interface WorkflowDefinitionInput {
  readonly organizationId: string;
  readonly name: string;
  readonly trigger: WorkflowTrigger;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly triggerConfig?: Workflow['triggerConfig'];
}

export interface WorkflowExecutionJob {
  readonly organizationId: string;
  readonly operationId: string;
  readonly workflowId: string;
  readonly principalId: string;
  readonly context?: DomainEventContext;
  readonly trigger: WorkflowTrigger;
  readonly payload: unknown;
  readonly idempotencyKey: string;
}

@Injectable()
export class WorkflowRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly workflows = new Map<string, Workflow>();
  private readonly store: WorkflowStore | undefined;
  private readonly runtime: WorkflowRuntime;
  private readonly administration: IdentityAdministrationService | undefined;
  private readonly eventSubscriptions = new Map<string, () => void>();

  async onModuleInit(): Promise<void> {
    this.models?.registerRedTeamExecutor(
      'WORKFLOW',
      async ({ organizationId, campaign, scenario, prompt }) => {
        const workflow = await this.get(organizationId, campaign.targetId);
        if (!workflow.published || workflow.trigger !== 'manual')
          throw new ValidationError(
            'Red-team workflow target must be published for manual execution',
          );
        const execution = await this.start({
          organizationId,
          workflowId: campaign.targetId,
          principalId: `system:red-team:${campaign.id}`,
          trigger: 'manual',
          payload: prompt,
          idempotencyKey: `red-team:${campaign.id}:${scenario.id}`,
        });
        if (execution.status !== 'COMPLETED')
          throw new ValidationError(`Red-team workflow execution ended with ${execution.status}`);
        const output =
          typeof execution.output === 'string'
            ? execution.output
            : JSON.stringify(execution.output ?? null);
        return {
          output,
          evidence: {
            workflowId: campaign.targetId,
            workflowExecutionId: execution.id,
            workflowStatus: execution.status,
          },
        };
      },
    );
    await this.restoreEventSubscriptions();
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.eventSubscriptions.values()) unsubscribe();
    this.eventSubscriptions.clear();
  }

  constructor(
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
    @Optional()
    @Inject(OperationsRuntimeService)
    private readonly operations?: OperationsRuntimeService,
    @Optional() @Inject(AgentRuntimeService) private readonly agents?: AgentRuntimeService,
    @Optional()
    @Inject(CapabilityRuntimeService)
    private readonly capabilities?: CapabilityRuntimeService,
    @Optional()
    @Inject(ModelAdminRuntimeService)
    private readonly models?: ModelAdminRuntimeService,
    @Optional() @Inject(McpRuntimeService) private readonly mcp?: McpRuntimeService,
    @Optional() @Inject(AuthRuntimeService) auth?: AuthRuntimeService,
    @Optional() @Inject(EventBusRuntimeService) private readonly eventBus?: EventBusRuntimeService,
  ) {
    this.administration =
      auth === undefined ? undefined : new IdentityAdministrationService(auth.storage);
    this.store =
      database === undefined
        ? undefined
        : new RepositoryWorkflowStore((name) => database.adapter.repository(name));
    this.runtime = new WorkflowRuntime(
      (node, input, context) => this.executeNode(node, input, context),
      this.store,
      (compensation, input, context) => this.executeCompensation(compensation, input, context),
    );
  }

  private executeCompensation: CompensationProvider = (compensation, input, context) =>
    this.executeNode(
      {
        id: `compensation:${compensation.nodeId}`,
        kind: compensation.kind as WorkflowNode['kind'],
        config: compensation.config,
      },
      input,
      context,
    ).then(() => undefined);

  private async executeNode(
    node: WorkflowNode,
    input: unknown,
    context: { organizationId: string; principalId: string; signal?: AbortSignal },
  ): Promise<unknown> {
    const permissions =
      this.administration === undefined
        ? []
        : await this.administration.listPrincipalPermissions(
            context.organizationId,
            context.principalId,
          );
    if (node.kind === 'Condition') {
      if (typeof node.config.pass === 'boolean' && !node.config.pass)
        return { input, skipped: true };
      return input;
    }
    if (node.kind === 'Agent') {
      if (this.agents === undefined) throw new ValidationError('Agent runtime is unavailable');
      const agentId = configString(node.config, 'agentId');
      if (agentId === undefined) throw new ValidationError('Agent node requires agentId');
      const prompt = configString(node.config, 'prompt') ?? stringifyWorkflowInput(input);
      return this.agents.runPublished({
        organizationId: context.organizationId,
        agentId,
        principalId: context.principalId,
        prompt,
        permissions,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
    }
    if (node.kind === 'Capability' || node.kind === 'Tool') {
      if (this.capabilities === undefined)
        throw new ValidationError('Capability runtime is unavailable');
      const slug = configString(node.config, 'slug') ?? configString(node.config, 'capability');
      if (slug === undefined) throw new ValidationError(`${node.kind} node requires slug`);
      const value = node.config.input === undefined ? input : node.config.input;
      return this.capabilities.engine.execute(slug, value, {
        organizationId: context.organizationId,
        principalId: context.principalId,
        permissions,
        channel: 'INTERNAL',
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
    }
    if (node.kind === 'LLM') {
      if (this.models === undefined) throw new ValidationError('Model runtime is unavailable');
      const model = configString(node.config, 'model');
      if (model === undefined) throw new ValidationError('LLM node requires model');
      const system = configString(node.config, 'systemPrompt');
      const messages = [
        ...(system === undefined ? [] : [{ role: 'system' as const, content: system }]),
        { role: 'user' as const, content: stringifyWorkflowInput(input) },
      ];
      const response = await this.models.execution.chat({
        organizationId: context.organizationId,
        model,
        dataClassification: 'INTERNAL',
        messages,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      return response.content;
    }
    if (node.kind === 'MCP') {
      if (this.mcp === undefined) throw new ValidationError('MCP runtime is unavailable');
      const serverId = configString(node.config, 'serverId');
      const toolName = configString(node.config, 'toolName');
      if (serverId === undefined || toolName === undefined)
        throw new ValidationError('MCP node requires serverId and toolName');
      return this.mcp.execute(context.organizationId, serverId, toolName, input, {
        organizationId: context.organizationId,
        principalId: context.principalId,
        permissions,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
    }
    throw new ValidationError(`Workflow node kind is not executable: ${node.kind}`);
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
      ...(input.triggerConfig === undefined ? {} : { triggerConfig: input.triggerConfig }),
      published: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.runtime.register(workflow);
    this.workflows.set(this.key(input.organizationId, workflow.id), workflow);
    await this.store?.saveWorkflow(workflow);
    await this.refreshEventSubscriptions(input.organizationId);
    return workflow;
  }

  async dispatchEvent(input: {
    readonly organizationId: string;
    readonly eventName: string;
    readonly principalId: string;
    readonly payload: unknown;
  }): Promise<readonly WorkflowExecution[]> {
    const workflows = (await this.list(input.organizationId)).filter(
      (workflow) =>
        workflow.published &&
        workflow.trigger === 'event' &&
        workflow.triggerConfig?.eventName === input.eventName,
    );
    return Promise.all(
      workflows.map((workflow) =>
        this.start({
          organizationId: input.organizationId,
          workflowId: workflow.id,
          principalId: input.principalId,
          trigger: 'event',
          payload: input.payload,
          idempotencyKey: `event:${input.eventName}:${uuidV7()}`,
        }),
      ),
    );
  }

  async dispatchDueSchedules(input: {
    readonly organizationId: string;
    readonly principalId: string;
    readonly payload?: unknown;
    readonly now?: Date;
  }): Promise<readonly WorkflowExecution[]> {
    const now = input.now ?? new Date();
    const workflows = (await this.list(input.organizationId)).filter(
      (workflow) => workflow.published && workflow.trigger === 'schedule',
    );
    const executions = await this.runtime.listExecutions(input.organizationId);
    const started: WorkflowExecution[] = [];
    for (const workflow of workflows) {
      const intervalSeconds = workflow.triggerConfig?.intervalSeconds;
      if (intervalSeconds === undefined) continue;
      const previous = executions
        .filter(
          (execution) => execution.workflowId === workflow.id && execution.trigger === 'schedule',
        )
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
      if (
        previous !== undefined &&
        now.getTime() - previous.createdAt.getTime() < intervalSeconds * 1000
      )
        continue;
      const slot = Math.floor(now.getTime() / (intervalSeconds * 1000));
      started.push(
        await this.start({
          organizationId: input.organizationId,
          workflowId: workflow.id,
          principalId: input.principalId,
          trigger: 'schedule',
          payload: input.payload ?? {},
          idempotencyKey: `schedule:${workflow.id}:${String(slot)}`,
        }),
      );
    }
    return started;
  }

  async publish(organizationId: string, workflowId: string): Promise<Workflow> {
    const current = await this.get(organizationId, workflowId);
    const published: Workflow = { ...current, published: true, updatedAt: new Date() };
    this.runtime.register(published);
    this.workflows.set(this.key(organizationId, workflowId), published);
    await this.store?.saveWorkflow(published);
    await this.refreshEventSubscriptions(organizationId);
    return published;
  }

  private async restoreEventSubscriptions(): Promise<void> {
    if (this.eventBus === undefined || this.database?.adapter.listAll === undefined) return;
    const organizations: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.database.adapter.listAll<Organization>(
        repositoryName('identity-organizations'),
        { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
      );
      organizations.push(
        ...page.items
          .filter((organization) => organization.status === 'ACTIVE')
          .map((organization) => organization.id),
      );
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    await Promise.all(
      organizations.map((organizationId) => this.refreshEventSubscriptions(organizationId)),
    );
  }

  private async refreshEventSubscriptions(organizationId: string): Promise<void> {
    if (this.eventBus === undefined) return;
    const eventNames = new Set(
      (await this.list(organizationId))
        .filter((workflow) => workflow.published && workflow.trigger === 'event')
        .map((workflow) => workflow.triggerConfig?.eventName)
        .filter((eventName): eventName is string => eventName !== undefined),
    );
    const prefix = `${organizationId}:`;
    for (const [key, unsubscribe] of this.eventSubscriptions) {
      if (key.startsWith(prefix) && !eventNames.has(key.slice(prefix.length))) {
        unsubscribe();
        this.eventSubscriptions.delete(key);
      }
    }
    for (const eventName of eventNames) {
      const key = `${organizationId}:${eventName}`;
      if (this.eventSubscriptions.has(key)) continue;
      const unsubscribe = this.eventBus.subscribe(eventName, (event) =>
        this.dispatchDomainEvent(organizationId, event),
      );
      this.eventSubscriptions.set(key, unsubscribe);
    }
  }

  private async dispatchDomainEvent(organizationId: string, event: DomainEvent): Promise<void> {
    if (event.organizationId !== organizationId) return;
    // Operation lifecycle events are internal bookkeeping; triggering workflows
    // from them would allow an operation-created workflow to recursively spawn itself.
    if (event.type === 'operation.created') return;
    const workflows = (await this.list(organizationId)).filter(
      (workflow) =>
        workflow.published &&
        workflow.trigger === 'event' &&
        workflow.triggerConfig?.eventName === event.type,
    );
    const principalId = event.context?.principalId ?? `system:event:${event.type}`.slice(0, 128);
    const context: DomainEventContext = event.context ?? {
      requestId: event.id.slice(0, 128),
      traceId: event.correlationId.slice(0, 128),
      principalId,
      source: 'SYSTEM',
    };
    await Promise.all(
      workflows.map((workflow) =>
        this.startAsync({
          organizationId,
          workflowId: workflow.id,
          principalId,
          trigger: 'event',
          payload: event.payload,
          idempotencyKey: `event:${createHash('sha256')
            .update(`${organizationId}\u0000${event.id}\u0000${workflow.id}`)
            .digest('hex')}`,
          context,
        }),
      ),
    );
  }

  start(input: {
    readonly organizationId: string;
    readonly workflowId: string;
    readonly principalId: string;
    readonly trigger: WorkflowTrigger;
    readonly payload: unknown;
    readonly idempotencyKey?: string;
    readonly context?: WorkflowExecutionContext;
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
    readonly context?: DomainEventContext;
    readonly signal?: AbortSignal;
  }) {
    if (this.operations === undefined)
      throw new ValidationError('Operations runtime is required for asynchronous workflows');
    const workflow = await this.get(input.organizationId, input.workflowId);
    if (!workflow.published) throw new ValidationError('Workflow is not published');
    if (workflow.trigger !== input.trigger)
      throw new ValidationError('Workflow trigger does not match the published workflow');
    const operation = await this.operations.createOperation({
      organizationId: input.organizationId,
      type: `workflow:${input.workflowId}`,
      idempotencyKey: input.idempotencyKey,
      ...(input.context === undefined ? {} : { context: input.context }),
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
    const job: WorkflowExecutionJob = {
      organizationId: input.organizationId,
      operationId: operation.id,
      workflowId: input.workflowId,
      principalId: input.principalId,
      ...(input.context === undefined ? {} : { context: input.context }),
      trigger: input.trigger,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
    };
    await this.operations.queue('workflow-executions', input.organizationId).enqueue({
      id: operation.id,
      payload: job,
      idempotencyKey: input.idempotencyKey,
      ...(input.context === undefined ? {} : { context: input.context }),
    });
    return operation;
  }

  async executeQueued(job: WorkflowExecutionJob) {
    if (this.operations === undefined)
      throw new ValidationError('Operations runtime is required for workflow execution jobs');
    const operation = await this.operations.getOperation(job.organizationId, job.operationId);
    if (operation === undefined) throw new ValidationError('Workflow operation was not found');
    if (
      operation.type !== `workflow:${job.workflowId}` ||
      operation.idempotencyKey !== job.idempotencyKey
    )
      throw new ValidationError('Workflow job does not match its operation');
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(operation.status))
      return operation;
    if (operation.status === 'PENDING') {
      try {
        await this.operations.operations.update(
          { ...operation, status: 'RUNNING' },
          operation.version,
        );
      } catch {
        const current = await this.operations.getOperation(job.organizationId, job.operationId);
        if (current?.status !== 'RUNNING') return current;
      }
    }
    const controller = new AbortController();
    const cancellationTimer = setInterval(() => {
      void this.operations?.getOperation(job.organizationId, job.operationId).then((current) => {
        if (current?.cancelRequested === true || current?.status === 'CANCELLED')
          controller.abort();
      });
    }, 50);
    try {
      const execution = await this.start({
        organizationId: job.organizationId,
        workflowId: job.workflowId,
        principalId: job.principalId,
        trigger: job.trigger,
        payload: job.payload,
        idempotencyKey: job.idempotencyKey,
        ...(job.context === undefined ? {} : { context: job.context }),
        signal: controller.signal,
      });
      const current = await this.operations.getOperation(job.organizationId, job.operationId);
      if (current?.status !== 'RUNNING') return current;
      return await this.operations.operations.update(
        {
          ...current,
          status: controller.signal.aborted
            ? 'CANCELLED'
            : execution.status === 'COMPLETED'
              ? 'SUCCEEDED'
              : 'FAILED',
          ...(execution.status === 'COMPLETED'
            ? { result: { executionId: execution.id } }
            : { errorCode: execution.error ?? 'workflow_execution_failed' }),
        },
        current.version,
      );
    } catch (error) {
      const current = await this.operations.getOperation(job.organizationId, job.operationId);
      if (current?.status !== 'RUNNING') return current;
      return await this.operations.operations.update(
        {
          ...current,
          status: controller.signal.aborted ? 'CANCELLED' : 'FAILED',
          errorCode: controller.signal.aborted
            ? 'workflow_execution_cancelled'
            : error instanceof ValidationError
              ? error.code
              : 'workflow_execution_failed',
        },
        current.version,
      );
    } finally {
      clearInterval(cancellationTimer);
    }
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

function configString(config: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = config[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function stringifyWorkflowInput(input: unknown): string {
  if (typeof input === 'string') return input;
  const serialized: unknown = JSON.stringify(input);
  return typeof serialized === 'string' ? serialized : String(input);
}
