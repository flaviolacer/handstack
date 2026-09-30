import type {
  CapabilityExecutionContext,
  CapabilityExecutionEngine,
} from '@handstack/capabilities';
import {
  repositoryName,
  uuidV7,
  type Repository,
  type RepositoryName,
  type TenantEntity,
} from '@handstack/domain';
import { ValidationError } from '@handstack/shared';

export type AgentVersionStatus = 'DRAFT' | 'PUBLISHED' | 'DEPRECATED';

export type AgentPublishChannel = 'WEB' | 'REST_API' | 'MCP' | 'AGENT_TOOL';

export interface AgentTemplate {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly tools: readonly string[];
  readonly configuration?: AgentVersionConfiguration;
}

/** First-party templates are immutable catalog data; installation creates tenant-owned entities. */
export const FIRST_PARTY_AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: 'general-assistant',
    slug: 'general-assistant',
    name: 'General Assistant',
    description: 'A governed general-purpose assistant.',
    model: 'smart',
    systemPrompt: 'You are a helpful, precise and transparent assistant.',
    tools: [],
    configuration: { publishChannels: ['WEB', 'REST_API'] },
  },
  {
    id: 'coding-assistant',
    slug: 'coding-assistant',
    name: 'Coding Assistant',
    description: 'A coding assistant that explains changes and trade-offs.',
    model: 'smart',
    systemPrompt:
      'You are a careful software engineer. Explain assumptions and produce maintainable code.',
    tools: [],
    configuration: {
      publishChannels: ['WEB', 'REST_API'],
      guardrails: ['secret-detection', 'prompt-injection'],
    },
  },
  {
    id: 'research-agent',
    slug: 'research-agent',
    name: 'Research Agent',
    description: 'A research-oriented agent for evidence-based answers.',
    model: 'smart',
    systemPrompt:
      'You are a research assistant. Separate facts, uncertainty and inference clearly.',
    tools: [],
    configuration: { publishChannels: ['WEB', 'REST_API'] },
  },
  {
    id: 'security-review-agent',
    slug: 'security-review-agent',
    name: 'Security Review Agent',
    description: 'A security review assistant with conservative output guardrails.',
    model: 'smart',
    systemPrompt:
      'You are a defensive security reviewer. Report evidence, impact and remediation without inventing facts.',
    tools: [],
    configuration: {
      publishChannels: ['WEB', 'REST_API'],
      guardrails: ['secret-detection', 'prompt-injection'],
    },
  },
];

export interface AgentVersionConfiguration {
  readonly mcpServers?: readonly string[];
  readonly knowledgeBaseIds?: readonly string[];
  readonly memoryEnabled?: boolean;
  readonly guardrails?: readonly string[];
  readonly permissions?: readonly string[];
  readonly publishChannels?: readonly AgentPublishChannel[];
}

export interface Agent {
  readonly id: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AgentVersion {
  readonly id: string;
  readonly agentId: string;
  readonly organizationId: string;
  readonly version: number;
  readonly status: AgentVersionStatus;
  readonly model: string;
  readonly systemPrompt: string;
  readonly tools: readonly string[];
  readonly maxIterations: number;
  readonly timeoutMs: number;
  readonly budgetUsd?: number;
  readonly configuration?: AgentVersionConfiguration;
  readonly createdAt: Date;
}

export interface AgentEntity extends Agent, TenantEntity {
  readonly organizationId: string;
}
export interface AgentVersionEntity extends AgentVersion, TenantEntity {
  readonly organizationId: string;
  readonly tenantId: string;
}

export interface AgentStore {
  saveAgent(agent: AgentEntity): Promise<AgentEntity>;
  findAgent(organizationId: string, agentId: string): Promise<AgentEntity | undefined>;
  listAgents(organizationId: string): Promise<readonly AgentEntity[]>;
  saveVersion(version: AgentVersionEntity): Promise<AgentVersionEntity>;
  listVersions(organizationId: string, agentId: string): Promise<readonly AgentVersionEntity[]>;
}

export class InMemoryAgentStore implements AgentStore {
  private readonly agents = new Map<string, AgentEntity>();
  private readonly versions = new Map<string, AgentVersionEntity>();
  async saveAgent(agent: AgentEntity): Promise<AgentEntity> {
    this.agents.set(`${agent.organizationId}:${agent.id}`, agent);
    return await Promise.resolve(agent);
  }
  async findAgent(organizationId: string, agentId: string): Promise<AgentEntity | undefined> {
    return await Promise.resolve(this.agents.get(`${organizationId}:${agentId}`));
  }
  async listAgents(organizationId: string): Promise<readonly AgentEntity[]> {
    return await Promise.resolve(
      [...this.agents.values()].filter((item) => item.organizationId === organizationId),
    );
  }
  async saveVersion(version: AgentVersionEntity): Promise<AgentVersionEntity> {
    this.versions.set(`${version.organizationId}:${version.id}`, version);
    return await Promise.resolve(version);
  }
  async listVersions(
    organizationId: string,
    agentId: string,
  ): Promise<readonly AgentVersionEntity[]> {
    return await Promise.resolve(
      [...this.versions.values()].filter(
        (item) => item.organizationId === organizationId && item.agentId === agentId,
      ),
    );
  }
}

export class RepositoryAgentStore implements AgentStore {
  private readonly agents: Repository<AgentEntity>;
  private readonly versions: Repository<AgentVersionEntity>;
  constructor(repository: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.agents = repository<AgentEntity>(repositoryName('agents'));
    this.versions = repository<AgentVersionEntity>(repositoryName('agent-versions'));
  }
  saveAgent(agent: AgentEntity): Promise<AgentEntity> {
    return this.persist(this.agents, agent, true);
  }
  findAgent(organizationId: string, agentId: string): Promise<AgentEntity | undefined> {
    return this.agents.findById(organizationId, agentId);
  }
  async listAgents(organizationId: string): Promise<readonly AgentEntity[]> {
    return this.listAll(this.agents, organizationId);
  }
  saveVersion(version: AgentVersionEntity): Promise<AgentVersionEntity> {
    return this.persist(this.versions, version, false);
  }
  async listVersions(
    organizationId: string,
    agentId: string,
  ): Promise<readonly AgentVersionEntity[]> {
    return (await this.listAll(this.versions, organizationId)).filter(
      (item) => item.agentId === agentId,
    );
  }
  private async listAll<T extends TenantEntity>(
    repository: Repository<T>,
    organizationId: string,
  ): Promise<readonly T[]> {
    const values: T[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      if (cursor !== undefined) {
        if (seenCursors.has(cursor))
          throw new ValidationError('Repository returned a repeated pagination cursor');
        seenCursors.add(cursor);
      }
      const page = await repository.list(organizationId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      values.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return values;
  }
  private async persist<T extends TenantEntity>(
    repository: Repository<T>,
    entity: T,
    increment: boolean,
  ): Promise<T> {
    const current = await repository.findById(entity.tenantId, entity.id);
    if (current === undefined) return repository.insert(entity);
    return repository.update(
      {
        ...entity,
        version: increment ? current.version + 1 : entity.version,
        createdAt: current.createdAt,
      },
      current.version,
    );
  }
}

export interface AgentMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
}

export interface AgentToolCall {
  readonly name: string;
  readonly arguments: unknown;
}

export type AgentModelResult =
  | {
      readonly kind: 'final';
      readonly content: string;
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
    }
  | {
      readonly kind: 'tool_call';
      readonly call: AgentToolCall;
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
    };

export interface AgentModel {
  complete(input: {
    model: string;
    messages: readonly AgentMessage[];
    tools: readonly string[];
    signal: AbortSignal;
  }): Promise<AgentModelResult>;
}

export type AgentEvent =
  | { readonly type: 'agent.started'; readonly runId: string }
  | { readonly type: 'agent.step.started'; readonly runId: string; readonly iteration: number }
  | { readonly type: 'agent.tool.called'; readonly runId: string; readonly tool: string }
  | { readonly type: 'agent.completed'; readonly runId: string; readonly iterations: number }
  | { readonly type: 'agent.failed'; readonly runId: string; readonly error: string };

/** Transport-neutral lifecycle signal for metrics and tracing consumers. */
export interface AgentOperationalObservation {
  readonly type: 'agent.started' | 'agent.tool.called' | 'agent.completed' | 'agent.failed';
}

export interface AgentRunInput {
  readonly organizationId: string;
  readonly principalId: string;
  readonly permissions?: readonly string[];
  readonly agentVersion: AgentVersion;
  readonly prompt: string;
  readonly channel?: AgentPublishChannel;
  readonly guardrails?: GuardrailPipeline;
  readonly mcpExecutor?: AgentMcpExecutor;
  readonly agentToolExecutor?: AgentToolExecutor;
  readonly memoryStore?: MemoryStore;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AgentEvent) => void | Promise<void>;
  readonly observe?: (observation: AgentOperationalObservation) => void;
}

export interface AgentToolExecutor {
  execute(
    toolName: string,
    argumentsValue: unknown,
    context: {
      readonly organizationId: string;
      readonly principalId: string;
      readonly permissions: readonly string[];
      readonly signal: AbortSignal;
    },
  ): Promise<{ readonly handled: boolean; readonly result?: unknown }>;
}

export interface AgentMcpExecutor {
  execute(
    toolName: string,
    argumentsValue: unknown,
    context: {
      readonly organizationId: string;
      readonly principalId: string;
      readonly permissions: readonly string[];
      readonly signal: AbortSignal;
    },
  ): Promise<unknown>;
}

export interface AgentRunResult {
  readonly runId: string;
  readonly content: string;
  readonly iterations: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export class AgentHarness {
  constructor(
    private readonly model: AgentModel,
    private readonly capabilities: CapabilityExecutionEngine,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const version = input.agentVersion;
    if (version.status !== 'PUBLISHED') throw new ValidationError('Agent version is not published');
    if (version.organizationId !== input.organizationId)
      throw new ValidationError('Agent organization mismatch');
    if (
      input.channel !== undefined &&
      version.configuration?.publishChannels !== undefined &&
      !version.configuration.publishChannels.includes(input.channel)
    )
      throw new ValidationError('Agent version is not published to this channel');
    if (version.maxIterations < 1 || version.maxIterations > 100)
      throw new ValidationError('Invalid agent iteration limit');
    const runId = uuidV7();
    const guardedPrompt =
      input.guardrails === undefined ? input.prompt : await input.guardrails.input(input.prompt);
    if (typeof guardedPrompt !== 'string')
      throw new ValidationError('Agent input guardrail must return a string');
    let memoryContext = '';
    if (version.configuration?.memoryEnabled) {
      if (input.memoryStore === undefined)
        throw new ValidationError('Agent memory runtime is unavailable');
      const memories = await input.memoryStore.list(
        input.organizationId,
        'USER',
        input.principalId,
      );
      memoryContext = memories
        .slice(-20)
        .map((entry) => entry.content)
        .join('\n---\n');
    }
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      controller.abort();
    }, version.timeoutMs);
    const messages: AgentMessage[] = [
      {
        role: 'system',
        content:
          memoryContext === ''
            ? version.systemPrompt
            : `${version.systemPrompt}\n\nRelevant user memory:\n${memoryContext}`,
      },
      { role: 'user', content: guardedPrompt },
    ];
    let inputTokens = 0;
    let outputTokens = 0;
    input.observe?.({ type: 'agent.started' });
    await input.onEvent?.({ type: 'agent.started', runId });
    try {
      for (let iteration = 1; iteration <= version.maxIterations; iteration += 1) {
        if (controller.signal.aborted) throw new Error('Agent run aborted');
        await input.onEvent?.({ type: 'agent.step.started', runId, iteration });
        const result = await this.model.complete({
          model: version.model,
          messages,
          tools: version.tools,
          signal: controller.signal,
        });
        inputTokens += result.usage?.inputTokens ?? 0;
        outputTokens += result.usage?.outputTokens ?? 0;
        if (result.kind === 'final') {
          const guardedOutput =
            input.guardrails === undefined
              ? result.content
              : await input.guardrails.output(result.content);
          if (typeof guardedOutput !== 'string')
            throw new ValidationError('Agent output guardrail must return a string');
          input.observe?.({ type: 'agent.completed' });
          await input.onEvent?.({ type: 'agent.completed', runId, iterations: iteration });
          if (version.configuration?.memoryEnabled && input.memoryStore !== undefined)
            await input.memoryStore.put({
              id: uuidV7(),
              organizationId: input.organizationId,
              scope: 'USER',
              ownerId: input.principalId,
              content: `User: ${guardedPrompt}\nAssistant: ${guardedOutput}`,
              createdAt: new Date(),
            });
          return {
            runId,
            content: guardedOutput,
            iterations: iteration,
            usage: { inputTokens, outputTokens },
          };
        }
        if (!version.tools.includes(result.call.name))
          throw new ValidationError('Agent requested an undeclared tool');
        input.observe?.({ type: 'agent.tool.called' });
        await input.onEvent?.({ type: 'agent.tool.called', runId, tool: result.call.name });
        const context: CapabilityExecutionContext = {
          organizationId: input.organizationId,
          principalId: input.principalId,
          channel: 'AGENT',
          signal: controller.signal,
          requestId: runId,
          ...(input.permissions === undefined
            ? {}
            : {
                permissions:
                  version.configuration?.permissions === undefined
                    ? input.permissions
                    : input.permissions.filter((permission) =>
                        version.configuration?.permissions?.includes(permission),
                      ),
              }),
        };
        const guardedArguments =
          input.guardrails === undefined
            ? result.call.arguments
            : await input.guardrails.tool(result.call.arguments);
        const toolResult = version.configuration?.mcpServers?.length
          ? input.mcpExecutor === undefined
            ? (() => {
                throw new ValidationError('Agent MCP runtime is unavailable');
              })()
            : await input.mcpExecutor.execute(result.call.name, guardedArguments, {
                organizationId: input.organizationId,
                principalId: input.principalId,
                permissions: context.permissions ?? [],
                signal: controller.signal,
              })
          : input.agentToolExecutor === undefined
            ? await this.capabilities.execute(result.call.name, guardedArguments, context)
            : await (async () => {
                const agentTool = await input.agentToolExecutor?.execute(
                  result.call.name,
                  guardedArguments,
                  {
                    organizationId: input.organizationId,
                    principalId: input.principalId,
                    permissions: context.permissions ?? [],
                    signal: controller.signal,
                  },
                );
                return agentTool?.handled
                  ? agentTool.result
                  : this.capabilities.execute(result.call.name, guardedArguments, context);
              })();
        messages.push(
          { role: 'assistant', content: JSON.stringify(result.call) },
          { role: 'tool', content: JSON.stringify(toolResult) },
        );
      }
      throw new Error('Agent iteration limit exceeded');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      input.observe?.({ type: 'agent.failed' });
      await input.onEvent?.({ type: 'agent.failed', runId, error: reason });
      throw error;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abort);
    }
  }
}

export type AgentOrchestrationMode = 'SEQUENTIAL' | 'PARALLEL' | 'SUPERVISOR';

export interface AgentTask {
  readonly agentId: string;
  readonly prompt: string;
}

export interface AgentTaskResult {
  readonly agentId: string;
  readonly content: string;
  readonly runId: string;
}

export interface AgentRunner {
  run(task: AgentTask, signal?: AbortSignal): Promise<AgentTaskResult>;
}

export class AgentOrchestrator {
  constructor(
    private readonly runner: AgentRunner,
    private readonly maxParallel = 4,
  ) {
    if (maxParallel < 1 || !Number.isInteger(maxParallel))
      throw new ValidationError('Invalid orchestration concurrency');
  }

  async execute(input: {
    readonly mode: AgentOrchestrationMode;
    readonly tasks: readonly AgentTask[];
    readonly supervisor?: AgentTask;
    readonly signal?: AbortSignal;
  }): Promise<readonly AgentTaskResult[]> {
    if (input.tasks.length === 0) return [];
    if (input.mode === 'SEQUENTIAL') {
      const results: AgentTaskResult[] = [];
      for (const task of input.tasks) results.push(await this.runner.run(task, input.signal));
      return results;
    }
    if (input.mode === 'SUPERVISOR') {
      if (input.supervisor === undefined) throw new ValidationError('Supervisor task is required');
      const delegated = await this.runner.run(input.supervisor, input.signal);
      return [delegated, ...(await this.parallel(input.tasks, input.signal))];
    }
    return this.parallel(input.tasks, input.signal);
  }

  private async parallel(
    tasks: readonly AgentTask[],
    signal?: AbortSignal,
  ): Promise<readonly AgentTaskResult[]> {
    const results: AgentTaskResult[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < tasks.length) {
        const index = cursor;
        cursor += 1;
        const task = tasks[index];
        if (task !== undefined) results[index] = await this.runner.run(task, signal);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.maxParallel, tasks.length) }, () => worker()),
    );
    return results;
  }
}

export type MemoryScope = 'NONE' | 'SESSION' | 'USER' | 'AGENT' | 'ORGANIZATION';

export interface MemoryEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly scope: Exclude<MemoryScope, 'NONE'>;
  readonly ownerId: string;
  readonly content: string;
  readonly createdAt: Date;
}

export interface MemoryStore {
  put(entry: MemoryEntry): Promise<void>;
  list(
    organizationId: string,
    scope: Exclude<MemoryScope, 'NONE'>,
    ownerId: string,
  ): Promise<readonly MemoryEntry[]>;
  delete(organizationId: string, id: string): Promise<void>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly values = new Map<string, MemoryEntry>();
  put(entry: MemoryEntry) {
    this.values.set(`${entry.organizationId}:${entry.id}`, entry);
    return Promise.resolve();
  }
  list(organizationId: string, scope: Exclude<MemoryScope, 'NONE'>, ownerId: string) {
    return Promise.resolve(
      [...this.values.values()].filter(
        (entry) =>
          entry.organizationId === organizationId &&
          entry.scope === scope &&
          entry.ownerId === ownerId,
      ),
    );
  }
  delete(organizationId: string, id: string) {
    this.values.delete(`${organizationId}:${id}`);
    return Promise.resolve();
  }
}

export class RepositoryMemoryStore implements MemoryStore {
  private readonly repository: Repository<MemoryEntry & TenantEntity>;
  constructor(repository: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.repository = repository<MemoryEntry & TenantEntity>(repositoryName('agent-memory'));
  }
  async put(entry: MemoryEntry): Promise<void> {
    await this.repository.insert({
      ...entry,
      tenantId: entry.organizationId,
      version: 1,
      updatedAt: entry.createdAt,
    });
  }
  async list(
    organizationId: string,
    scope: Exclude<MemoryScope, 'NONE'>,
    ownerId: string,
  ): Promise<readonly MemoryEntry[]> {
    return (await this.repository.list(organizationId, { limit: 200 })).items.filter(
      (entry) => entry.scope === scope && entry.ownerId === ownerId,
    );
  }
  async delete(organizationId: string, id: string): Promise<void> {
    const entry = await this.repository.findById(organizationId, id);
    if (entry !== undefined) await this.repository.delete(organizationId, id, entry.version);
  }
}

export type GuardrailStage = 'INPUT' | 'TOOL' | 'OUTPUT';
export type Guardrail = (input: unknown, stage: GuardrailStage) => Promise<unknown>;

export class GuardrailPipeline {
  constructor(private readonly guardrails: readonly Guardrail[]) {}
  async input(value: unknown) {
    return this.apply(value, 'INPUT');
  }
  async tool(value: unknown) {
    return this.apply(value, 'TOOL');
  }
  async output(value: unknown) {
    return this.apply(value, 'OUTPUT');
  }
  private async apply(value: unknown, stage: GuardrailStage) {
    let current = value;
    for (const guardrail of this.guardrails) current = await guardrail(current, stage);
    return current;
  }
}
