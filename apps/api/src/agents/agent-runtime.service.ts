import { Inject, Injectable, Optional } from '@nestjs/common';
import { uuidV7 } from '@handstack/domain';
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
} from '@handstack/agents';
import { ValidationError } from '@handstack/shared';
import { CapabilityRuntimeService } from '../capabilities/capability-runtime.service.js';
import { ApiMetrics } from '../observability/api-metrics.js';
import { createAgentMetricsObserver } from '@handstack/telemetry';

@Injectable()
export class AgentRuntimeService {
  private readonly store: AgentStore;
  constructor(
    @Optional() @Inject(DatabaseService) database?: DatabaseService,
    @Optional()
    @Inject(CapabilityRuntimeService)
    private readonly capabilities?: CapabilityRuntimeService,
    @Optional() @Inject(ApiMetrics) private readonly metrics: ApiMetrics = new ApiMetrics(),
  ) {
    this.database = database;
    this.store =
      database === undefined
        ? new InMemoryAgentStore()
        : new RepositoryAgentStore((name) => database.adapter.repository(name));
  }

  private readonly database: DatabaseService | undefined;

  async run(model: AgentModel, input: Omit<AgentRunInput, 'observe'>) {
    if (this.capabilities === undefined)
      throw new ValidationError('Agent execution runtime is unavailable');
    return new AgentHarness(model, this.capabilities.engine).run({
      ...input,
      observe: createAgentMetricsObserver(this.metrics),
    });
  }

  async list(organizationId: string): Promise<readonly Agent[]> {
    return (await this.store.listAgents(organizationId)).map(normalizeAgent);
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
  }): Promise<AgentVersion> {
    await this.get(input.organizationId, input.agentId);
    const current = await this.store.listVersions(input.organizationId, input.agentId);
    const maxIterations = input.maxIterations ?? 10;
    const timeoutMs = input.timeoutMs ?? 120_000;
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

function normalizeAgent(agent: Agent): Agent {
  return { ...agent, createdAt: new Date(agent.createdAt), updatedAt: new Date(agent.updatedAt) };
}

function normalizeVersion(version: AgentVersion): AgentVersion {
  return { ...version, createdAt: new Date(version.createdAt) };
}
