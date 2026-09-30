import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { repositoryName, uuidV7, type Repository, type TenantEntity } from '@handstack/domain';
import { DatabaseService } from '../database/database.service.js';
import {
  AgentHarness,
  InMemoryAgentStore,
  RepositoryAgentStore,
  type Agent,
  type AgentModel,
  type AgentRunInput,
  type AgentStore,
  type AgentVersion,
  type AgentVersionConfiguration,
  type AgentPublishChannel,
  type AgentToolExecutor,
  type AgentMcpExecutor,
  InMemoryMemoryStore,
  RepositoryMemoryStore,
  type MemoryStore,
  GuardrailPipeline,
  FIRST_PARTY_AGENT_TEMPLATES,
  type AgentTemplate,
  type AgentEvent,
} from '@handstack/agents';
import { ValidationError } from '@handstack/shared';
import { CapabilityRuntimeService } from '../capabilities/capability-runtime.service.js';
import { ApiMetrics } from '../observability/api-metrics.js';
import { createAgentMetricsObserver } from '@handstack/telemetry';
import { ModelAdminRuntimeService } from '../models/model-admin-runtime.service.js';
import { KnowledgeRuntimeService } from '../knowledge/knowledge-runtime.service.js';
import { McpRuntimeService } from '../mcp/mcp-runtime.service.js';
import { listAllTenant } from '../database/pagination.js';

export interface StoredAgentRun extends TenantEntity {
  readonly organizationId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly principalId: string;
  readonly status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  readonly iterations?: number;
  readonly error?: string;
}
export interface StoredAgentStep extends TenantEntity {
  readonly organizationId: string;
  readonly runId: string;
  readonly iteration: number;
  readonly status: 'RUNNING';
}
export interface StoredToolExecution extends TenantEntity {
  readonly organizationId: string;
  readonly runId: string;
  readonly tool: string;
  readonly status: 'STARTED';
}

@Injectable()
export class AgentRuntimeService implements OnModuleInit {
  private readonly store: AgentStore;
  private readonly memory: MemoryStore;
  private readonly runs: Repository<StoredAgentRun> | undefined;
  private readonly steps: Repository<StoredAgentStep> | undefined;
  private readonly toolExecutions: Repository<StoredToolExecution> | undefined;
  constructor(
    @Optional() @Inject(DatabaseService) database?: DatabaseService,
    @Optional()
    @Inject(CapabilityRuntimeService)
    private readonly capabilities?: CapabilityRuntimeService,
    @Optional() @Inject(ApiMetrics) private readonly metrics: ApiMetrics = new ApiMetrics(),
    @Optional()
    @Inject(ModelAdminRuntimeService)
    private readonly models?: ModelAdminRuntimeService,
    @Optional()
    @Inject(KnowledgeRuntimeService)
    private readonly knowledge?: KnowledgeRuntimeService,
    @Optional() @Inject(McpRuntimeService) private readonly mcp?: McpRuntimeService,
  ) {
    this.database = database;
    this.runs = database?.adapter.repository(repositoryName('agent-runs'));
    this.steps = database?.adapter.repository(repositoryName('agent-steps'));
    this.toolExecutions = database?.adapter.repository(repositoryName('tool-executions'));
    this.memory =
      database === undefined
        ? new InMemoryMemoryStore()
        : new RepositoryMemoryStore((name) => database.adapter.repository(name));
    this.store =
      database === undefined
        ? new InMemoryAgentStore()
        : new RepositoryAgentStore((name) => database.adapter.repository(name));
  }

  private readonly database: DatabaseService | undefined;

  onModuleInit(): void {
    this.models?.registerRedTeamExecutor(
      'AGENT',
      async ({ organizationId, campaign, scenario, prompt }) => {
        const result = await this.runPublished({
          organizationId,
          agentId: campaign.targetId,
          principalId: `system:red-team:${campaign.id}`,
          prompt,
          channel: 'REST_API',
          permissions: [],
        });
        return {
          output: result.content,
          evidence: {
            agentId: campaign.targetId,
            scenarioId: scenario.id,
            runId: result.runId,
            iterations: result.iterations,
            usage: result.usage,
          },
        };
      },
    );
  }

  async run(model: AgentModel, input: Omit<AgentRunInput, 'observe'>) {
    if (this.capabilities === undefined)
      throw new ValidationError('Agent execution runtime is unavailable');
    return new AgentHarness(model, this.capabilities.engine).run({
      ...input,
      observe: createAgentMetricsObserver(this.metrics),
    });
  }

  async runPublished(input: {
    organizationId: string;
    agentId: string;
    principalId: string;
    prompt: string;
    channel?: AgentPublishChannel;
    /** Internal recursion guard for Agent Tool delegation. */
    agentToolDepth?: number;
    permissions?: readonly string[];
    signal?: AbortSignal;
    onEvent?: AgentRunInput['onEvent'];
  }) {
    if (this.models === undefined)
      throw new ValidationError('Model execution runtime is unavailable');
    const models = this.models;
    const agent = await this.resolveAgent(input.organizationId, input.agentId);
    const version = (await this.versionsFor(input.organizationId, agent.id)).find(
      (item) => item.status === 'PUBLISHED',
    );
    if (version === undefined) throw new ValidationError('Agent has no published version');
    let prompt = input.prompt;
    const knowledgeBaseIds = version.configuration?.knowledgeBaseIds ?? [];
    if (knowledgeBaseIds.length > 0) {
      if (this.knowledge === undefined)
        throw new ValidationError('Agent Knowledge runtime is unavailable');
      const knowledge = this.knowledge;
      const context = (
        await Promise.all(
          knowledgeBaseIds.map((knowledgeBaseId) =>
            knowledge.search(
              input.organizationId,
              knowledgeBaseId,
              input.prompt,
              version.model,
              input.principalId,
              5,
            ),
          ),
        )
      ).flat();
      if (context.length > 0)
        prompt = `${input.prompt}\n\nRelevant governed knowledge context:\n${context
          .map((item): string => {
            const quote: string = item.citation.quote;
            return quote;
          })
          .join('\n---\n')}`;
    }
    const guardrailIds = version.configuration?.guardrails ?? [];
    const guardrails =
      guardrailIds.length === 0
        ? undefined
        : new GuardrailPipeline(guardrailIds.map((id) => builtInGuardrail(id)));
    const mcpServers = version.configuration?.mcpServers ?? [];
    let mcpExecutor: AgentMcpExecutor | undefined;
    if (mcpServers.length > 0) {
      if (this.mcp === undefined) throw new ValidationError('Agent MCP runtime is unavailable');
      const mcp = this.mcp;
      mcpExecutor = {
        execute: async (toolName, argumentsValue, context) => {
          for (const serverId of mcpServers) {
            const tools = await mcp.listTools(input.organizationId, serverId);
            const tool = tools.find((candidate) => candidate.name === toolName);
            if (tool !== undefined) {
              if (
                tool.requiredPermissions.some(
                  (permission) => !context.permissions.includes(permission),
                )
              )
                throw new ValidationError('Agent MCP tool permission is not granted');
              return mcp.execute(input.organizationId, serverId, toolName, argumentsValue, context);
            }
          }
          throw new ValidationError('Agent MCP tool is not available on an authorized server');
        },
      };
    }
    const agentToolDepth = input.agentToolDepth ?? 0;
    const agentToolExecutor: AgentToolExecutor = {
      execute: async (toolName, argumentsValue, context) => {
        let target: Agent | undefined;
        try {
          target = await this.resolveAgent(input.organizationId, toolName);
        } catch {
          return { handled: false };
        }
        const targetVersion = (await this.versionsFor(input.organizationId, target.id)).find(
          (candidate) =>
            candidate.status === 'PUBLISHED' &&
            candidate.configuration?.publishChannels?.includes('AGENT_TOOL'),
        );
        if (targetVersion === undefined) return { handled: false };
        if (agentToolDepth >= 8) throw new ValidationError('Agent Tool recursion limit exceeded');
        const prompt = agentToolPrompt(argumentsValue);
        const result = await this.runPublished({
          organizationId: input.organizationId,
          agentId: target.id,
          principalId: context.principalId,
          prompt,
          channel: 'AGENT_TOOL',
          agentToolDepth: agentToolDepth + 1,
          permissions: context.permissions,
          signal: context.signal,
        });
        return { handled: true, result };
      },
    };
    const model: AgentModel = {
      complete: async ({ model: modelId, messages, tools, signal }) => {
        const response = await models.execution.chat({
          organizationId: input.organizationId,
          model: modelId,
          dataClassification: 'INTERNAL',
          messages,
          tools: tools.map((name) => ({ name, inputSchema: { type: 'object' } })),
          signal,
        });
        const toolCall = response.toolCalls?.[0];
        if (response.finishReason === 'tool_call' && toolCall !== undefined)
          return {
            kind: 'tool_call' as const,
            call: { name: toolCall.name, arguments: toolCall.arguments },
            usage: response.usage,
          };
        return { kind: 'final' as const, content: response.content, usage: response.usage };
      },
    };
    return this.run(model, {
      organizationId: input.organizationId,
      principalId: input.principalId,
      agentVersion: version,
      prompt,
      ...(version.configuration?.memoryEnabled ? { memoryStore: this.memory } : {}),
      ...(guardrails === undefined ? {} : { guardrails }),
      channel: 'REST_API',
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      ...(mcpExecutor === undefined ? {} : { mcpExecutor }),
      agentToolExecutor,
      ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onEvent: async (event) => {
        await this.persistRunEvent(
          input.organizationId,
          input.principalId,
          agent.id,
          version.id,
          event,
        );
        await input.onEvent?.(event);
      },
    });
  }

  private async persistRunEvent(
    organizationId: string,
    principalId: string,
    agentId: string,
    agentVersionId: string,
    event: AgentEvent,
  ): Promise<void> {
    if (this.runs === undefined || this.steps === undefined || this.toolExecutions === undefined)
      return;
    if (event.type === 'agent.started') {
      await this.runs.insert({
        id: event.runId,
        tenantId: organizationId,
        organizationId,
        agentId,
        agentVersionId,
        principalId,
        status: 'RUNNING',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return;
    }
    if (event.type === 'agent.step.started') {
      await this.steps.insert({
        id: uuidV7(),
        tenantId: organizationId,
        organizationId,
        runId: event.runId,
        iteration: event.iteration,
        status: 'RUNNING',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return;
    }
    if (event.type === 'agent.tool.called') {
      await this.toolExecutions.insert({
        id: uuidV7(),
        tenantId: organizationId,
        organizationId,
        runId: event.runId,
        tool: event.tool,
        status: 'STARTED',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return;
    }
    const current = await this.runs.findById(organizationId, event.runId);
    if (current === undefined) return;
    const next =
      event.type === 'agent.completed'
        ? { ...current, status: 'SUCCEEDED' as const, iterations: event.iterations }
        : { ...current, status: 'FAILED' as const, error: event.error };
    await this.runs.update(
      { ...next, version: current.version + 1, updatedAt: new Date() },
      current.version,
    );
  }

  private async resolveAgent(organizationId: string, idOrSlug: string): Promise<Agent> {
    try {
      return await this.get(organizationId, idOrSlug);
    } catch {
      const match = (await this.list(organizationId)).find((agent) => agent.slug === idOrSlug);
      if (match === undefined) throw new ValidationError('Agent not found');
      return match;
    }
  }

  async list(organizationId: string): Promise<readonly Agent[]> {
    return (await this.store.listAgents(organizationId)).map(normalizeAgent);
  }

  async listRuns(organizationId: string, agentId: string): Promise<readonly StoredAgentRun[]> {
    if (this.runs === undefined) return [];
    return (await listAllTenant(this.runs, organizationId)).filter(
      (run) => run.agentId === agentId,
    );
  }

  listTemplates(): readonly AgentTemplate[] {
    return FIRST_PARTY_AGENT_TEMPLATES;
  }

  async installTemplate(
    organizationId: string,
    templateId: string,
  ): Promise<{ agent: Agent; version: AgentVersion }> {
    const template = FIRST_PARTY_AGENT_TEMPLATES.find((candidate) => candidate.id === templateId);
    if (template === undefined) throw new ValidationError('Agent template not found');
    const agent = await this.create({
      organizationId,
      slug: template.slug,
      name: template.name,
      description: template.description,
    });
    const draft = await this.createVersion({
      organizationId,
      agentId: agent.id,
      model: template.model,
      systemPrompt: template.systemPrompt,
      tools: template.tools,
      ...(template.configuration === undefined ? {} : { configuration: template.configuration }),
    });
    const version = await this.publish(organizationId, agent.id, draft.id);
    return { agent, version };
  }

  async get(organizationId: string, agentId: string): Promise<Agent> {
    const agent = await this.store.findAgent(organizationId, agentId);
    if (agent?.organizationId !== organizationId) throw new ValidationError('Agent not found');
    return normalizeAgent(agent);
  }

  async create(input: {
    organizationId: string;
    slug: string;
    name: string;
    description?: string;
  }): Promise<Agent> {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(input.slug))
      throw new ValidationError('Agent slug must contain lowercase letters, numbers and hyphens');
    if ((await this.list(input.organizationId)).some((agent) => agent.slug === input.slug))
      throw new ValidationError('Agent slug already exists');
    const now = new Date();
    const agent: Agent = {
      id: uuidV7(),
      organizationId: input.organizationId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveAgent({ ...agent, tenantId: input.organizationId, version: 1 });
    return agent;
  }

  async versionsFor(organizationId: string, agentId: string): Promise<readonly AgentVersion[]> {
    await this.get(organizationId, agentId);
    return (await this.store.listVersions(organizationId, agentId)).map(normalizeVersion);
  }

  createVersion(input: {
    organizationId: string;
    agentId: string;
    model: string;
    systemPrompt: string;
    tools?: readonly string[];
    maxIterations?: number;
    timeoutMs?: number;
    budgetUsd?: number;
    configuration?: AgentVersionConfiguration;
  }): Promise<AgentVersion> {
    return this.createVersionAsync(input);
  }

  private async createVersionAsync(input: {
    organizationId: string;
    agentId: string;
    model: string;
    systemPrompt: string;
    tools?: readonly string[];
    maxIterations?: number;
    timeoutMs?: number;
    budgetUsd?: number;
    configuration?: AgentVersionConfiguration;
  }): Promise<AgentVersion> {
    await this.get(input.organizationId, input.agentId);
    const current = await this.store.listVersions(input.organizationId, input.agentId);
    const maxIterations = input.maxIterations ?? 10;
    const timeoutMs = input.timeoutMs ?? this.database?.config.timeouts.agent ?? 120_000;
    if (maxIterations < 1 || maxIterations > 100)
      throw new ValidationError('Invalid agent iteration limit');
    if (timeoutMs < 1 || timeoutMs > 3_600_000) throw new ValidationError('Invalid agent timeout');
    const version: AgentVersion = {
      id: uuidV7(),
      agentId: input.agentId,
      organizationId: input.organizationId,
      version: current.length + 1,
      status: 'DRAFT',
      model: input.model,
      systemPrompt: input.systemPrompt,
      tools: [...(input.tools ?? [])],
      maxIterations,
      timeoutMs,
      ...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd }),
      ...(input.configuration === undefined ? {} : { configuration: input.configuration }),
      createdAt: new Date(),
    };
    await this.store.saveVersion({
      ...version,
      tenantId: input.organizationId,
      version: version.version,
      updatedAt: version.createdAt,
    });
    return version;
  }

  async publish(organizationId: string, agentId: string, versionId: string): Promise<AgentVersion> {
    if (this.database !== undefined) {
      return this.database.adapter.run((context) =>
        this.publishWithStore(
          organizationId,
          agentId,
          versionId,
          new RepositoryAgentStore((name) => context.repository(name)),
        ),
      );
    }
    return this.publishWithStore(organizationId, agentId, versionId, this.store);
  }

  async rollback(organizationId: string, agentId: string): Promise<AgentVersion> {
    const versions = await this.versionsFor(organizationId, agentId);
    const published = versions.find((version) => version.status === 'PUBLISHED');
    if (published === undefined) throw new ValidationError('Published agent version not found');
    const previous = versions
      .filter((version) => version.status === 'DEPRECATED' && version.id !== published.id)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
    if (previous === undefined) throw new ValidationError('Previous agent version not found');
    return this.publish(organizationId, agentId, previous.id);
  }

  private async publishWithStore(
    organizationId: string,
    agentId: string,
    versionId: string,
    store: AgentStore,
  ): Promise<AgentVersion> {
    const agent = await store.findAgent(organizationId, agentId);
    if (agent?.organizationId !== organizationId) throw new ValidationError('Agent not found');
    const current = await store.listVersions(organizationId, agentId);
    const target = current.find((version) => version.id === versionId);
    if (target === undefined) throw new ValidationError('Agent version not found');
    const updated = current.map((version): AgentVersion => {
      const status: AgentVersion['status'] =
        version.id === versionId
          ? 'PUBLISHED'
          : version.status === 'PUBLISHED'
            ? 'DEPRECATED'
            : version.status;
      return { ...version, status };
    });
    for (const version of updated)
      await store.saveVersion({
        ...version,
        tenantId: organizationId,
        version: version.version,
        updatedAt: new Date(),
      });
    const published = updated.find((version) => version.id === versionId);
    if (published === undefined) throw new ValidationError('Agent version not found');
    return published;
  }
}

function builtInGuardrail(
  id: string,
): (value: unknown, stage: 'INPUT' | 'TOOL' | 'OUTPUT') => Promise<unknown> {
  if (id === 'secret-detection')
    return (value) => {
      if (
        typeof value === 'string' &&
        /(?:api[_ -]?key|secret|bearer)\s*[:=]\s*[\w./+\-=]{8,}/iu.test(value)
      )
        return Promise.reject(new ValidationError('Guardrail blocked a secret-like value'));
      return Promise.resolve(value);
    };
  if (id === 'prompt-injection')
    return (value, stage) => {
      if (
        stage === 'INPUT' &&
        typeof value === 'string' &&
        /ignore\s+(?:all\s+)?previous\s+instructions|reveal\s+(?:the\s+)?system\s+prompt/iu.test(
          value,
        )
      )
        return Promise.reject(new ValidationError('Guardrail blocked a prompt injection pattern'));
      return Promise.resolve(value);
    };
  throw new ValidationError(`Unknown agent guardrail: ${id}`);
}

function agentToolPrompt(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { readonly prompt?: unknown }).prompt === 'string' &&
    (value as { readonly prompt: string }).prompt.trim() !== ''
  )
    return (value as { readonly prompt: string }).prompt;
  throw new ValidationError('Agent Tool requires a prompt');
}

function normalizeAgent(agent: Agent): Agent {
  return { ...agent, createdAt: new Date(agent.createdAt), updatedAt: new Date(agent.updatedAt) };
}

function normalizeVersion(version: AgentVersion): AgentVersion {
  return { ...version, createdAt: new Date(version.createdAt) };
}
