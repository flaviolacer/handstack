import {
  uuidV7,
  type Repository,
  type RepositoryName,
  type TenantEntity,
  repositoryName,
} from '@handstack/domain';
import { InMemoryApprovalService } from '@handstack/policy';
import { ValidationError } from '@handstack/shared';

export type WorkflowTrigger = 'manual' | 'api' | 'webhook' | 'schedule' | 'event';
export type WorkflowNodeKind =
  'Agent' | 'Capability' | 'LLM' | 'Tool' | 'MCP' | 'Condition' | 'Human Approval' | 'Loop';
export type WorkflowExecutionStatus =
  'RUNNING' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

export interface WorkflowNode {
  readonly id: string;
  readonly kind: WorkflowNodeKind;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
  readonly condition?: string;
}

export interface Workflow extends TenantEntity {
  readonly organizationId: string;
  readonly name: string;
  readonly trigger: WorkflowTrigger;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly published: boolean;
}

export interface WorkflowExecution extends TenantEntity {
  readonly organizationId: string;
  readonly workflowId: string;
  readonly principalId: string;
  /** Trigger is persisted so idempotent replays cover the full request shape. */
  readonly trigger?: WorkflowTrigger;
  readonly idempotencyKey?: string;
  readonly status: WorkflowExecutionStatus;
  readonly input: unknown;
  readonly output?: unknown;
  readonly currentNodeId?: string;
  readonly loopIterations?: Readonly<Record<string, number>>;
  readonly approvalId?: string;
  readonly error?: string;
}

export interface WorkflowStepExecution extends TenantEntity {
  readonly organizationId: string;
  readonly executionId: string;
  readonly nodeId: string;
  readonly idempotencyKey: string;
  readonly status:
    'RUNNING' | 'COMPLETED' | 'WAITING_APPROVAL' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  readonly input: unknown;
  readonly output?: unknown;
  readonly startedAt: Date;
  readonly completedAt?: Date;
}

export interface WorkflowStore {
  saveWorkflow(workflow: Workflow): Promise<Workflow>;
  listWorkflows(organizationId: string): Promise<readonly Workflow[]>;
  findWorkflow(organizationId: string, workflowId: string): Promise<Workflow | undefined>;
  saveExecution(execution: WorkflowExecution): Promise<WorkflowExecution>;
  findExecution(
    organizationId: string,
    executionId: string,
  ): Promise<WorkflowExecution | undefined>;
  findExecutionByIdempotencyKey?(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<WorkflowExecution | undefined>;
  saveStep(step: WorkflowStepExecution): Promise<WorkflowStepExecution>;
  listSteps(organizationId: string, executionId: string): Promise<readonly WorkflowStepExecution[]>;
}

/** Adapter-neutral durable store backed by the canonical tenant repository contract. */
export class RepositoryWorkflowStore implements WorkflowStore {
  private readonly workflows: Repository<Workflow>;
  private readonly executions: Repository<WorkflowExecution>;
  private readonly steps: Repository<WorkflowStepExecution>;
  constructor(repository: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.workflows = repository<Workflow>(repositoryName('workflows'));
    this.executions = repository<WorkflowExecution>(repositoryName('workflow-executions'));
    this.steps = repository<WorkflowStepExecution>(repositoryName('workflow-steps'));
  }
  saveWorkflow(workflow: Workflow): Promise<Workflow> {
    return this.persist(this.workflows, workflow);
  }
  findWorkflow(organizationId: string, workflowId: string): Promise<Workflow | undefined> {
    return this.workflows.findById(organizationId, workflowId);
  }
  async listWorkflows(organizationId: string): Promise<readonly Workflow[]> {
    const items: Workflow[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.workflows.list(organizationId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      items.push(...page.items);
      if (page.nextCursor !== undefined && page.nextCursor === cursor)
        throw new ValidationError('Workflow repository cursor repeated');
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  }
  saveExecution(execution: WorkflowExecution): Promise<WorkflowExecution> {
    return this.persist(this.executions, execution);
  }
  findExecution(
    organizationId: string,
    executionId: string,
  ): Promise<WorkflowExecution | undefined> {
    return this.executions.findById(organizationId, executionId);
  }
  async findExecutionByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<WorkflowExecution | undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.executions.list(organizationId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const match = page.items.find((execution) => execution.idempotencyKey === idempotencyKey);
      if (match !== undefined) return match;
      if (page.nextCursor !== undefined && page.nextCursor === cursor)
        throw new ValidationError('Workflow repository cursor repeated');
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return undefined;
  }
  saveStep(step: WorkflowStepExecution): Promise<WorkflowStepExecution> {
    return this.persist(this.steps, step);
  }
  async listSteps(
    organizationId: string,
    executionId: string,
  ): Promise<readonly WorkflowStepExecution[]> {
    const items: WorkflowStepExecution[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.steps.list(organizationId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      items.push(...page.items.filter((step) => step.executionId === executionId));
      if (page.nextCursor !== undefined && page.nextCursor === cursor)
        throw new ValidationError('Workflow repository cursor repeated');
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  }
  private async persist<T extends TenantEntity>(repository: Repository<T>, entity: T): Promise<T> {
    const current = await repository.findById(entity.tenantId, entity.id);
    return current === undefined
      ? repository.insert(entity)
      : repository.update(entity, current.version);
  }
}

export type WorkflowNodeExecutor = (
  node: WorkflowNode,
  input: unknown,
  context: {
    readonly organizationId: string;
    readonly principalId: string;
    readonly signal?: AbortSignal;
  },
) => Promise<unknown>;

const DEFAULT_WORKFLOW_INPUT = Symbol('default-workflow-input');

export class WorkflowRuntime {
  private readonly workflows = new Map<string, Workflow>();
  private readonly executions = new Map<string, WorkflowExecution>();
  private readonly steps = new Map<string, WorkflowStepExecution>();
  private readonly idempotencyLocks = new Map<string, Promise<WorkflowExecution>>();
  private readonly approvals = new InMemoryApprovalService();

  constructor(
    private readonly executeNode: WorkflowNodeExecutor,
    private readonly store?: WorkflowStore,
  ) {}

  register(workflow: Workflow): void {
    validateWorkflow(workflow);
    const key = `${workflow.organizationId}:${workflow.id}`;
    const current = this.workflows.get(key);
    if (
      current?.published === true &&
      (!workflow.published || !sameWorkflowGraph(current, workflow))
    )
      throw new ValidationError('Published workflow graph is immutable');
    this.workflows.set(key, workflow);
  }

  async start(input: {
    readonly organizationId: string;
    readonly workflowId: string;
    readonly principalId: string;
    readonly trigger: WorkflowTrigger;
    readonly payload: unknown;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkflowExecution> {
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    if (idempotencyKey === undefined) return this.startOnce(input, undefined);
    const lockKey = `${input.organizationId}:${idempotencyKey}`;
    const previous = this.idempotencyLocks.get(lockKey);
    if (previous !== undefined) return previous;
    const pending = this.startOnce(input, idempotencyKey);
    this.idempotencyLocks.set(lockKey, pending);
    try {
      return await pending;
    } finally {
      if (this.idempotencyLocks.get(lockKey) === pending) this.idempotencyLocks.delete(lockKey);
    }
  }

  private async startOnce(
    input: {
      readonly organizationId: string;
      readonly workflowId: string;
      readonly principalId: string;
      readonly trigger: WorkflowTrigger;
      readonly payload: unknown;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    },
    normalizedIdempotencyKey: string | undefined,
  ): Promise<WorkflowExecution> {
    const workflow = this.require(input.organizationId, input.workflowId);
    if (!workflow.published || workflow.trigger !== input.trigger)
      throw new ValidationError('Workflow is not published for this trigger');
    const existing = await this.findExecutionByIdempotencyKey(
      input.organizationId,
      normalizedIdempotencyKey,
    );
    if (existing !== undefined) {
      if (!sameExecutionRequest(existing, input))
        throw new ValidationError(
          'Idempotency key has already been used for another workflow request',
        );
      this.executions.set(this.key(input.organizationId, existing.id), existing);
      return existing;
    }
    const execution: WorkflowExecution = {
      id: uuidV7(),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      workflowId: workflow.id,
      principalId: input.principalId,
      trigger: input.trigger,
      ...(normalizedIdempotencyKey === undefined
        ? {}
        : { idempotencyKey: normalizedIdempotencyKey }),
      status: 'RUNNING',
      input: input.payload,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.executions.set(this.key(input.organizationId, execution.id), execution);
    await this.persistExecution(execution);
    return this.run(execution, workflow, input.signal, undefined, DEFAULT_WORKFLOW_INPUT);
  }

  async resume(
    organizationId: string,
    executionId: string,
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<WorkflowExecution> {
    const execution = this.executions.get(this.key(organizationId, executionId));
    if (execution?.status !== 'WAITING_APPROVAL')
      throw new ValidationError('Workflow execution is not waiting for approval');
    if (execution.approvalId !== approvalId)
      throw new ValidationError('Approval does not belong to workflow execution');
    await this.approvals.requireApproved(organizationId, approvalId);
    const workflow = this.require(organizationId, execution.workflowId);
    const continuationNode =
      execution.currentNodeId === undefined
        ? undefined
        : nextNode(workflow.edges, execution.currentNodeId, approvalId);
    return this.run(
      { ...execution, status: 'RUNNING' },
      workflow,
      signal,
      continuationNode,
      DEFAULT_WORKFLOW_INPUT,
    );
  }

  async recover(
    organizationId: string,
    executionId: string,
    signal?: AbortSignal,
  ): Promise<WorkflowExecution> {
    const execution = this.executions.get(this.key(organizationId, executionId));
    if (execution?.status !== 'RUNNING' && execution?.status !== 'FAILED')
      throw new ValidationError('Workflow execution is not recoverable');
    const workflow = this.require(organizationId, execution.workflowId);
    const checkpoints =
      this.store === undefined
        ? this.listSteps(organizationId, executionId)
        : await this.store.listSteps(organizationId, executionId);
    const lastCompleted = [...checkpoints]
      .filter((step) => step.status === 'COMPLETED')
      .sort(
        (left, right) => (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0),
      )[0];
    // A process can fail after persisting a completed step but before advancing
    // the execution checkpoint. Resume from the transition derived from the
    // durable step, otherwise recovery executes that step twice.
    const recoveryNodeId =
      lastCompleted === undefined
        ? execution.currentNodeId
        : nextNode(workflow.edges, lastCompleted.nodeId, lastCompleted.output);
    return this.run(
      execution,
      workflow,
      signal,
      recoveryNodeId,
      lastCompleted === undefined ? execution.input : lastCompleted.output,
    );
  }

  async hydrate(execution: WorkflowExecution, workflow: Workflow): Promise<void> {
    this.require(execution.organizationId, workflow.id);
    if (this.executions.has(this.key(execution.organizationId, execution.id))) return;
    this.executions.set(this.key(execution.organizationId, execution.id), execution);
    if (execution.status !== 'WAITING_APPROVAL' || execution.approvalId === undefined) return;
    const node = workflow.nodes.find((candidate) => candidate.id === execution.currentNodeId);
    if (node?.kind !== 'Human Approval')
      throw new ValidationError('Workflow approval node not found');
    await this.approvals.request({
      id: execution.approvalId,
      organizationId: execution.organizationId,
      requesterId: execution.principalId,
      resource: `workflow:${workflow.id}`,
      action: 'continue',
      payloadDigest: execution.id,
      requiredApprovers: asApprovers(node.config.approvers),
    });
  }

  listSteps(organizationId: string, executionId: string): readonly WorkflowStepExecution[] {
    return [...this.steps.values()]
      .filter((step) => step.organizationId === organizationId && step.executionId === executionId)
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
  }

  async approve(organizationId: string, approvalId: string, approverId: string) {
    return this.approvals.approve(organizationId, approvalId, approverId);
  }
  get(organizationId: string, executionId: string) {
    return this.executions.get(this.key(organizationId, executionId));
  }

  private async run(
    execution: WorkflowExecution,
    workflow: Workflow,
    signal: AbortSignal | undefined,
    startNodeId: string | undefined,
    initialValue: unknown,
  ): Promise<WorkflowExecution> {
    let current = startNodeId ?? workflow.nodes[0]?.id;
    let value = initialValue === DEFAULT_WORKFLOW_INPUT ? execution.input : initialValue;
    let currentExecution = execution;
    let activeStep: WorkflowStepExecution | undefined;
    const loopIterations = new Map(Object.entries(execution.loopIterations ?? {}));
    try {
      while (current !== undefined) {
        if (signal?.aborted) throw new Error('Workflow execution cancelled');
        const node = workflow.nodes.find((candidate) => candidate.id === current);
        if (node === undefined) throw new ValidationError('Workflow node not found');
        if (node.kind === 'Loop') {
          const iteration = (loopIterations.get(node.id) ?? 0) + 1;
          const maxIterations = loopMaxIterations(node);
          if (maxIterations === undefined || iteration > maxIterations)
            throw new ValidationError('Workflow loop iteration limit exceeded');
          loopIterations.set(node.id, iteration);
        }
        const stepIdempotencyKey = `${execution.id}:${node.id}:${String(
          loopIterations.get(node.id) ?? 0,
        )}`;
        currentExecution = {
          ...currentExecution,
          status: 'RUNNING',
          currentNodeId: node.id,
          ...(loopIterations.size === 0
            ? {}
            : { loopIterations: Object.fromEntries(loopIterations) }),
          updatedAt: new Date(),
        };
        this.executions.set(this.key(execution.organizationId, execution.id), currentExecution);
        await this.persistExecution(currentExecution);
        const step: WorkflowStepExecution = {
          id: uuidV7(),
          tenantId: execution.organizationId,
          organizationId: execution.organizationId,
          executionId: execution.id,
          nodeId: node.id,
          idempotencyKey: stepIdempotencyKey,
          status: 'RUNNING',
          input: value,
          version: 1,
          startedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        activeStep = step;
        this.steps.set(this.key(execution.organizationId, step.id), step);
        await this.persistStep(step);
        if (node.kind === 'Human Approval') {
          const approval = await this.approvals.request({
            id: uuidV7(),
            organizationId: execution.organizationId,
            requesterId: execution.principalId,
            resource: `workflow:${workflow.id}`,
            action: 'continue',
            payloadDigest: execution.id,
            requiredApprovers: asApprovers(node.config.approvers),
          });
          const waiting = {
            ...currentExecution,
            status: 'WAITING_APPROVAL' as const,
            currentNodeId: node.id,
            approvalId: approval.id,
            updatedAt: new Date(),
          };
          this.executions.set(this.key(execution.organizationId, execution.id), waiting);
          const waitingStep = {
            ...step,
            status: 'WAITING_APPROVAL' as const,
            output: approval.id,
            completedAt: new Date(),
          };
          activeStep = waitingStep;
          this.steps.set(this.key(execution.organizationId, step.id), waitingStep);
          await this.persistStep(waitingStep);
          await this.persistExecution(waiting);
          return waiting;
        }
        value = await this.executeNodeWithRetry(node, value, {
          organizationId: execution.organizationId,
          principalId: execution.principalId,
          ...(signal === undefined ? {} : { signal }),
        });
        assertOutputWithinLimit(node, value);
        if (signal?.aborted === true) throw new Error('Workflow execution cancelled');
        const completedStep = {
          ...step,
          status: 'COMPLETED' as const,
          output: value,
          completedAt: new Date(),
        };
        activeStep = completedStep;
        this.steps.set(this.key(execution.organizationId, step.id), completedStep);
        await this.persistStep(completedStep);
        current = nextNode(workflow.edges, node.id, value);
        currentExecution = {
          ...currentExecution,
          ...(current === undefined ? {} : { currentNodeId: current }),
          updatedAt: new Date(),
        };
        this.executions.set(this.key(execution.organizationId, execution.id), currentExecution);
        await this.persistExecution(currentExecution);
      }
      const completed = {
        ...currentExecution,
        status: 'COMPLETED' as const,
        output: value,
        updatedAt: new Date(),
      };
      this.executions.set(this.key(execution.organizationId, execution.id), completed);
      await this.persistExecution(completed);
      return completed;
    } catch (error) {
      const timedOut = error instanceof WorkflowTimeoutError && signal?.aborted !== true;
      if (activeStep?.status === 'RUNNING') {
        const failedStep = {
          ...activeStep,
          status: timedOut
            ? ('TIMED_OUT' as const)
            : signal?.aborted === true
              ? ('CANCELLED' as const)
              : ('FAILED' as const),
          completedAt: new Date(),
        };
        this.steps.set(this.key(execution.organizationId, failedStep.id), failedStep);
        await this.persistStep(failedStep);
      }
      const failed = {
        ...currentExecution,
        status: timedOut
          ? ('TIMED_OUT' as const)
          : signal?.aborted === true
            ? ('CANCELLED' as const)
            : ('FAILED' as const),
        error: timedOut
          ? 'workflow_step_timeout'
          : error instanceof WorkflowOutputLimitError
            ? 'workflow_output_too_large'
            : error instanceof WorkflowOutputSerializationError
              ? 'workflow_output_invalid'
              : signal?.aborted === true
                ? 'workflow_execution_cancelled'
                : error instanceof Error
                  ? error.message
                  : String(error),
        updatedAt: new Date(),
      };
      this.executions.set(this.key(execution.organizationId, execution.id), failed);
      await this.persistExecution(failed);
      return failed;
    }
  }

  private executeNodeWithTimeout(
    node: WorkflowNode,
    input: unknown,
    context: {
      readonly organizationId: string;
      readonly principalId: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const timeout = timeoutMs(node);
    if (timeout === undefined) return this.executeNode(node, input, context);
    const controller = new AbortController();
    const forwardAbort = () => {
      controller.abort();
    };
    if (context.signal?.aborted === true) controller.abort();
    else context.signal?.addEventListener('abort', forwardAbort, { once: true });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new WorkflowTimeoutError());
      }, timeout);
      void this.executeNode(node, input, { ...context, signal: controller.signal })
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timer);
          context.signal?.removeEventListener('abort', forwardAbort);
        });
    });
  }

  private async executeNodeWithRetry(
    node: WorkflowNode,
    input: unknown,
    context: {
      readonly organizationId: string;
      readonly principalId: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const policy = retryPolicy(node);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.executeNodeWithTimeout(node, input, context);
      } catch (error) {
        if (attempt >= policy.maxAttempts || isAborted(context.signal)) throw error;
        if (policy.backoffMs > 0) await waitForRetryBackoff(policy.backoffMs, context.signal);
        if (isAborted(context.signal)) throw error;
      }
    }
  }

  private persistExecution(execution: WorkflowExecution): Promise<WorkflowExecution> {
    return this.store === undefined
      ? Promise.resolve(execution)
      : this.store.saveExecution(execution);
  }

  private persistStep(step: WorkflowStepExecution): Promise<WorkflowStepExecution> {
    return this.store === undefined ? Promise.resolve(step) : this.store.saveStep(step);
  }

  private require(organizationId: string, workflowId: string) {
    const workflow = this.workflows.get(this.key(organizationId, workflowId));
    if (workflow === undefined) throw new ValidationError('Workflow not found');
    return workflow;
  }
  private key(organizationId: string, id: string) {
    return `${organizationId}:${id}`;
  }

  private async findExecutionByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string | undefined,
  ): Promise<WorkflowExecution | undefined> {
    if (idempotencyKey === undefined) return undefined;
    const inMemory = [...this.executions.values()].find(
      (execution) =>
        execution.organizationId === organizationId && execution.idempotencyKey === idempotencyKey,
    );
    return (
      inMemory ??
      (await this.store?.findExecutionByIdempotencyKey?.(organizationId, idempotencyKey))
    );
  }
}

function validateWorkflow(workflow: Workflow): void {
  if (
    workflow.id === '' ||
    workflow.tenantId === '' ||
    workflow.organizationId === '' ||
    workflow.tenantId !== workflow.organizationId ||
    workflow.nodes.length === 0
  )
    throw new ValidationError('Workflow organization and nodes are required');
  const ids = new Set(workflow.nodes.map((node) => node.id));
  if (
    workflow.nodes.some((node) => node.id === '') ||
    ids.size !== workflow.nodes.length ||
    workflow.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))
  )
    throw new ValidationError('Workflow graph is invalid');
  if (
    workflow.nodes.some(
      (node) => node.kind === 'Human Approval' && asApprovers(node.config.approvers).length === 0,
    )
  )
    throw new ValidationError('Human Approval nodes require approvers');
  for (const edge of workflow.edges) validateCondition(edge.condition);
  for (const node of workflow.nodes) timeoutMs(node);
  for (const node of workflow.nodes) retryPolicy(node);
  for (const node of workflow.nodes) outputLimitBytes(node);
  for (const node of workflow.nodes) loopMaxIterations(node);

  const outgoing = new Map<string, string[]>();
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const node of workflow.nodes) outgoing.set(node.id, []);
  for (const edge of workflow.edges) outgoing.get(edge.from)?.push(edge.to);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      if (nodesById.get(nodeId)?.kind === 'Loop') return;
      throw new ValidationError('Workflow graph contains a cycle');
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) visit(next);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of workflow.nodes) visit(node.id);
}

class WorkflowTimeoutError extends Error {
  constructor() {
    super('Workflow step timed out');
    this.name = 'WorkflowTimeoutError';
  }
}

class WorkflowOutputLimitError extends Error {
  constructor() {
    super('Workflow step output exceeds its configured limit');
    this.name = 'WorkflowOutputLimitError';
  }
}

class WorkflowOutputSerializationError extends Error {
  constructor() {
    super('Workflow step output cannot be serialized');
    this.name = 'WorkflowOutputSerializationError';
  }
}

function timeoutMs(node: WorkflowNode): number | undefined {
  const value = node.config.timeoutMs;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 86_400_000)
    throw new ValidationError('Workflow node timeoutMs must be an integer between 1 and 86400000');
  return value;
}

function outputLimitBytes(node: WorkflowNode): number | undefined {
  const value = node.config.maxOutputBytes;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10_000_000)
    throw new ValidationError(
      'Workflow node maxOutputBytes must be an integer between 1 and 10000000',
    );
  return value;
}

function loopMaxIterations(node: WorkflowNode): number | undefined {
  if (node.kind !== 'Loop') return undefined;
  const value = node.config.maxIterations;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10_000)
    throw new ValidationError('Workflow Loop maxIterations must be an integer between 1 and 10000');
  return value;
}

function assertOutputWithinLimit(node: WorkflowNode, output: unknown): void {
  const limit = outputLimitBytes(node);
  if (limit === undefined) return;
  let serialized: string | undefined;
  try {
    serialized = stringifyForLimit(output);
  } catch {
    throw new WorkflowOutputSerializationError();
  }
  const bytes = serialized === undefined ? 0 : new TextEncoder().encode(serialized).byteLength;
  if (bytes > limit) throw new WorkflowOutputLimitError();
}

// JSON.stringify is typed to return string, but returns undefined for
// undefined/function/symbol inputs; the wider signature keeps guards live.
function stringifyForLimit(value: unknown): string | undefined {
  return JSON.stringify(value);
}

function nextNode(
  edges: readonly WorkflowEdge[],
  from: string,
  output: unknown,
): string | undefined {
  return edges.find(
    (edge) =>
      edge.from === from &&
      (edge.condition === undefined || matchesCondition(edge.condition, output)),
  )?.to;
}

function validateCondition(condition: string | undefined): void {
  if (condition === undefined) return;
  const value = condition.trim();
  if (value === 'true' || value === 'false' || value === 'output.exists') return;
  if (/^output\s*(===|!==|==|!=)\s*.+$/.test(value)) {
    const literal = value.replace(/^output\s*(===|!==|==|!=)\s*/, '');
    try {
      JSON.parse(literal);
      return;
    } catch {
      // Fall through to the typed validation error below.
    }
  }
  throw new ValidationError('Workflow edge condition is not deterministic or valid');
}

function matchesCondition(condition: string, output: unknown): boolean {
  const value = condition.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'output.exists') return output !== undefined && output !== null;
  const match = /^output\s*(===|!==|==|!=)\s*(.+)$/.exec(value);
  if (match === null)
    throw new ValidationError('Workflow edge condition is not deterministic or valid');
  const operator = match[1];
  const literal = match[2];
  if (operator === undefined || literal === undefined)
    throw new ValidationError('Workflow edge condition is not deterministic or valid');
  const expected: unknown = JSON.parse(literal);
  const equal = JSON.stringify(output) === JSON.stringify(expected);
  return operator === '!=' || operator === '!==' ? !equal : equal;
}

interface WorkflowRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: number;
}

function retryPolicy(node: WorkflowNode): WorkflowRetryPolicy {
  const value = node.config.retry;
  if (value === undefined) return { maxAttempts: 1, backoffMs: 0 };
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ValidationError('Workflow node retry must be an object');
  const candidate = value as { readonly maxAttempts?: unknown; readonly backoffMs?: unknown };
  const maxAttempts = candidate.maxAttempts ?? 1;
  const backoffMs = candidate.backoffMs ?? 0;
  if (
    typeof maxAttempts !== 'number' ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10 ||
    typeof backoffMs !== 'number' ||
    !Number.isInteger(backoffMs) ||
    backoffMs < 0 ||
    backoffMs > 60_000
  )
    throw new ValidationError(
      'Workflow node retry must use maxAttempts 1-10 and backoffMs 0-60000',
    );
  return { maxAttempts, backoffMs };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function waitForRetryBackoff(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new Error('Workflow execution cancelled'));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(resolve);
    }, delayMs);
    const abort = () => {
      finish(() => {
        reject(new Error('Workflow execution cancelled'));
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    function finish(callback: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    }
  });
}

function sameWorkflowGraph(left: Workflow, right: Workflow): boolean {
  return (
    JSON.stringify({ nodes: left.nodes, edges: left.edges }) ===
    JSON.stringify({ nodes: right.nodes, edges: right.edges })
  );
}

function asApprovers(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalizeIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized === '' || normalized.length > 200)
    throw new ValidationError('Workflow idempotencyKey must contain 1-200 characters');
  return normalized;
}

function sameExecutionRequest(
  execution: WorkflowExecution,
  input: {
    readonly organizationId: string;
    readonly workflowId: string;
    readonly principalId: string;
    readonly trigger: WorkflowTrigger;
    readonly payload: unknown;
  },
): boolean {
  return (
    execution.organizationId === input.organizationId &&
    execution.workflowId === input.workflowId &&
    execution.principalId === input.principalId &&
    execution.trigger === input.trigger &&
    safelyEqual(execution.input, input.payload)
  );
}

function safelyEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
