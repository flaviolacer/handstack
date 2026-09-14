import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '@handstack/database';
import {
  repositoryName,
  uuidV7,
  type Repository,
  type TransactionContext,
} from '@handstack/domain';
import type {
  AiGovernanceTelemetry,
  AiGovernanceOperation,
  EvaluationGate,
  EvaluationProvider,
  EvaluationRunResult,
  ModelAuditEvent,
  ModelAuditEventType,
  ModelDefinition,
  Prompt,
  PromptEvaluationGate,
  PromptVersion,
  ProviderDefinition,
} from '@handstack/models';

const providerRepository = repositoryName('model-providers');
const modelRepository = repositoryName('model-definitions');
const gateRepository = repositoryName('model-evaluation-gates');
const promptRepository = repositoryName('prompts');
const promptVersionRepository = repositoryName('prompt-versions');
const promptGateRepository = repositoryName('prompt-evaluation-gates');
const auditRepository = repositoryName('model-audit-events');

export const modelRegistrySchema = {
  version: 3,
  repositories: {
    providers: providerRepository,
    models: modelRepository,
    gates: gateRepository,
    prompts: promptRepository,
    promptVersions: promptVersionRepository,
    promptGates: promptGateRepository,
    auditEvents: auditRepository,
  },
} as const;

const directTelemetry: AiGovernanceTelemetry = {
  measure: (_operation, work) => work(),
  measureStream: (_operation, work) => work(),
};

async function all<
  T extends { id: string; tenantId: string; version: number; createdAt: Date; updatedAt: Date },
>(repository: Repository<T>, organizationId: string): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list(organizationId, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    result.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return result;
}

export class ModelRegistry {
  private readonly providers: Repository<ProviderDefinition>;
  private readonly models: Repository<ModelDefinition>;
  private readonly prompts: Repository<Prompt>;
  private readonly promptVersions: Repository<PromptVersion>;

  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly evaluationProvider?: EvaluationProvider,
    private readonly telemetry: AiGovernanceTelemetry = directTelemetry,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.providers = adapter.repository(providerRepository);
    this.models = adapter.repository(modelRepository);
    this.prompts = adapter.repository(promptRepository);
    this.promptVersions = adapter.repository(promptVersionRepository);
  }

  async registerPrompt(prompt: Prompt): Promise<Prompt> {
    return this.telemetry.measure('prompt.register', () =>
      this.adapter.run(async (context) => {
        this.assertScope(prompt.organizationId, prompt);
        const prompts = context.repository<Prompt>(promptRepository);
        if ((await all(prompts, prompt.organizationId)).some(({ slug }) => slug === prompt.slug))
          throw new Error('Prompt slug already exists');
        const saved = await prompts.insert(prompt);
        await this.appendAudit(
          context,
          prompt.organizationId,
          'PROMPT_REGISTERED',
          'prompt',
          prompt.id,
          { slug: prompt.slug },
        );
        return saved;
      }),
    );
  }

  async registerPromptVersion(promptVersion: PromptVersion): Promise<PromptVersion> {
    return this.telemetry.measure('prompt.version.register', () =>
      this.adapter.run(async (context) => {
        this.assertScope(promptVersion.organizationId, promptVersion);
        const prompt = await context
          .repository<Prompt>(promptRepository)
          .findById(promptVersion.organizationId, promptVersion.promptId);
        if (prompt === undefined) throw new Error('Prompt not found');
        const model = await context
          .repository<ModelDefinition>(modelRepository)
          .findById(promptVersion.organizationId, promptVersion.modelDefinitionId);
        if (model === undefined || model.lifecycle === 'RETIRED')
          throw new Error('Prompt model route not found');
        if (promptVersion.lifecycle !== 'DRAFT')
          throw new Error('New prompt versions must start as DRAFT');
        if (promptVersion.contentDigest !== this.promptDigest(promptVersion.content))
          throw new Error('Prompt content digest mismatch');
        const names = promptVersion.variables.map(({ name }) => name);
        if (new Set(names).size !== names.length)
          throw new Error('Prompt variables must be unique');
        const referenced = new Set(
          [...promptVersion.content.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map(
            (match) => match[1],
          ),
        );
        if (referenced.size !== names.length || names.some((name) => !referenced.has(name)))
          throw new Error('Prompt variables must exactly match content placeholders');
        const versions = context.repository<PromptVersion>(promptVersionRepository);
        if (
          (await all(versions, promptVersion.organizationId)).some(
            (item) =>
              item.promptId === promptVersion.promptId &&
              item.versionLabel === promptVersion.versionLabel,
          )
        )
          throw new Error('Prompt version label already exists');
        const saved = await versions.insert(promptVersion);
        await this.appendAudit(
          context,
          promptVersion.organizationId,
          'PROMPT_VERSION_REGISTERED',
          'prompt_version',
          promptVersion.id,
          {
            promptId: promptVersion.promptId,
            versionLabel: promptVersion.versionLabel,
            modelDefinitionId: promptVersion.modelDefinitionId,
          },
        );
        return saved;
      }),
    );
  }

  async registerProvider(provider: ProviderDefinition): Promise<ProviderDefinition> {
    return this.telemetry.measure('provider.register', () =>
      this.adapter.run(async (context) => {
        this.assertScope(provider.organizationId, provider);
        const providers = context.repository<ProviderDefinition>(providerRepository);
        if (
          (await all(providers, provider.organizationId)).some(({ name }) => name === provider.name)
        )
          throw new Error('Provider name already exists');
        const saved = await providers.insert(provider);
        await this.appendAudit(
          context,
          provider.organizationId,
          'PROVIDER_REGISTERED',
          'provider',
          provider.id,
          {
            adapter: provider.adapter,
            enabled: provider.enabled,
          },
        );
        return saved;
      }),
    );
  }

  async registerModel(model: ModelDefinition): Promise<ModelDefinition> {
    return this.telemetry.measure('model.register', () =>
      this.adapter.run(async (context) => {
        this.assertScope(model.organizationId, model);
        const providers = context.repository<ProviderDefinition>(providerRepository);
        const models = context.repository<ModelDefinition>(modelRepository);
        const provider = await providers.findById(model.organizationId, model.providerId);
        if (provider?.enabled !== true) throw new Error('Enabled provider not found');
        const existing = await all(models, model.organizationId);
        const aliases = new Set(model.aliases);
        if (
          model.aliases.length !== aliases.size ||
          existing.some((item) => item.aliases.some((alias) => aliases.has(alias)))
        )
          throw new Error('Model alias already exists');
        if (model.lifecycle !== 'DRAFT') throw new Error('New models must start as DRAFT');
        const saved = await models.insert(model);
        await this.appendAudit(
          context,
          model.organizationId,
          'MODEL_REGISTERED',
          'model',
          model.id,
          {
            providerId: model.providerId,
            lifecycle: model.lifecycle,
          },
        );
        return saved;
      }),
    );
  }

  async recordGate(gate: EvaluationGate, result: EvaluationRunResult): Promise<ModelDefinition> {
    return this.telemetry.measure('model.gate.record', async () => {
      this.assertScope(gate.organizationId, gate);
      if (this.evaluationProvider === undefined)
        throw new Error('Evaluation provider is required to record a gate');
      if (
        gate.runId !== result.runId ||
        gate.datasetVersion !== result.datasetVersion ||
        gate.passed !== result.passed ||
        JSON.stringify(gate.scores) !== JSON.stringify(result.scores)
      )
        throw new Error('Evaluation gate does not match its run result');
      const decision = await this.evaluationProvider.validateGate({
        organizationId: gate.organizationId,
        modelDefinitionId: gate.modelDefinitionId,
        suiteId: gate.suiteId,
        suiteVersion: gate.suiteVersion,
        result,
      });
      if (decision.passed !== gate.passed)
        throw new Error('Evaluation provider decision does not match the gate');
      return this.adapter.run(async (context) => {
        const models = context.repository<ModelDefinition>(modelRepository);
        const model = await models.findById(gate.organizationId, gate.modelDefinitionId);
        if (model === undefined) throw new Error('Model not found');
        await context.repository<EvaluationGate>(gateRepository).insert(gate);
        const updated = await models.update(
          {
            ...model,
            version: model.version + 1,
            updatedAt: gate.evaluatedAt,
            lifecycle: gate.passed ? 'EVALUATED' : 'DRAFT',
            evaluationSuiteVersion: gate.suiteVersion,
            ...(gate.passed ? { approvedGateId: gate.id } : {}),
          },
          model.version,
        );
        await this.appendAudit(
          context,
          gate.organizationId,
          'MODEL_GATE_RECORDED',
          'model',
          model.id,
          {
            gateId: gate.id,
            runId: gate.runId,
            suiteVersion: gate.suiteVersion,
            datasetVersion: gate.datasetVersion,
            passed: gate.passed,
          },
        );
        return updated;
      });
    });
  }

  async approve(organizationId: string, modelId: string): Promise<ModelDefinition> {
    return this.telemetry.measure('model.approve', () =>
      this.adapter.run(async (context) => {
        const models = context.repository<ModelDefinition>(modelRepository);
        const model = await models.findById(organizationId, modelId);
        if (model === undefined) throw new Error('Model not found');
        if (model.lifecycle !== 'EVALUATED' || model.approvedGateId === undefined)
          throw new Error('Passing evaluation gate is required');
        const updatedAt = this.now();
        const updated = await models.update(
          { ...model, version: model.version + 1, updatedAt, lifecycle: 'APPROVED' },
          model.version,
        );
        await this.appendAudit(
          context,
          organizationId,
          'MODEL_APPROVED',
          'model',
          model.id,
          {
            gateId: model.approvedGateId,
            from: model.lifecycle,
            to: 'APPROVED',
          },
          updatedAt,
        );
        return updated;
      }),
    );
  }

  async publish(organizationId: string, modelId: string): Promise<ModelDefinition> {
    return this.telemetry.measure('model.publish', () =>
      this.adapter.run(async (context) => {
        const models = context.repository<ModelDefinition>(modelRepository);
        const model = await models.findById(organizationId, modelId);
        if (model === undefined) throw new Error('Model not found');
        if (model.lifecycle !== 'APPROVED' || model.approvedGateId === undefined)
          throw new Error('Approved evaluation gate is required for publication');
        const gate = await context
          .repository<EvaluationGate>(gateRepository)
          .findById(organizationId, model.approvedGateId);
        if (
          gate === undefined ||
          !gate.passed ||
          gate.suiteVersion !== model.evaluationSuiteVersion
        )
          throw new Error('Evaluation gate is stale or failed');
        const updatedAt = this.now();
        const updated = await models.update(
          { ...model, version: model.version + 1, updatedAt, lifecycle: 'PUBLISHED' },
          model.version,
        );
        await this.appendAudit(
          context,
          organizationId,
          'MODEL_PUBLISHED',
          'model',
          model.id,
          {
            gateId: model.approvedGateId,
            from: model.lifecycle,
            to: 'PUBLISHED',
          },
          updatedAt,
        );
        return updated;
      }),
    );
  }

  async recordPromptGate(
    gate: PromptEvaluationGate,
    result: EvaluationRunResult,
  ): Promise<PromptVersion> {
    return this.telemetry.measure('prompt.gate.record', async () => {
      this.assertScope(gate.organizationId, gate);
      if (this.evaluationProvider === undefined)
        throw new Error('Evaluation provider is required to record a prompt gate');
      if (
        gate.runId !== result.runId ||
        gate.datasetVersion !== result.datasetVersion ||
        gate.passed !== result.passed ||
        JSON.stringify(gate.scores) !== JSON.stringify(result.scores)
      )
        throw new Error('Prompt evaluation gate does not match its run result');
      const promptVersion = await this.promptVersions.findById(
        gate.organizationId,
        gate.promptVersionId,
      );
      if (promptVersion === undefined)
        throw new Error('Prompt evaluation subject does not match the current version');
      if (
        promptVersion.modelDefinitionId !== gate.modelDefinitionId ||
        promptVersion.contentDigest !== gate.promptContentDigest
      )
        throw new Error('Prompt evaluation subject does not match the current version');
      const decision = await this.evaluationProvider.validateGate({
        organizationId: gate.organizationId,
        modelDefinitionId: gate.modelDefinitionId,
        suiteId: gate.suiteId,
        suiteVersion: gate.suiteVersion,
        promptVersionId: gate.promptVersionId,
        promptContentDigest: gate.promptContentDigest,
        result,
      });
      if (decision.passed !== gate.passed)
        throw new Error('Evaluation provider decision does not match the prompt gate');
      return this.adapter.run(async (context) => {
        const versions = context.repository<PromptVersion>(promptVersionRepository);
        const current = await versions.findById(gate.organizationId, gate.promptVersionId);
        if (current === undefined) throw new Error('Prompt version changed after evaluation');
        if (
          current.contentDigest !== gate.promptContentDigest ||
          current.modelDefinitionId !== gate.modelDefinitionId
        )
          throw new Error('Prompt version changed after evaluation');
        await context.repository<PromptEvaluationGate>(promptGateRepository).insert(gate);
        const updated = await versions.update(
          {
            ...current,
            version: current.version + 1,
            updatedAt: gate.evaluatedAt,
            lifecycle: gate.passed ? 'EVALUATED' : 'DRAFT',
            evaluationSuiteVersion: gate.suiteVersion,
            ...(gate.passed ? { approvedGateId: gate.id } : {}),
          },
          current.version,
        );
        await this.appendAudit(
          context,
          gate.organizationId,
          'PROMPT_GATE_RECORDED',
          'prompt_version',
          current.id,
          {
            promptId: current.promptId,
            gateId: gate.id,
            runId: gate.runId,
            suiteVersion: gate.suiteVersion,
            passed: gate.passed,
          },
        );
        return updated;
      });
    });
  }

  async approvePromptVersion(
    organizationId: string,
    promptVersionId: string,
  ): Promise<PromptVersion> {
    return this.transitionPromptVersion(
      organizationId,
      promptVersionId,
      'EVALUATED',
      'APPROVED',
      'PROMPT_APPROVED',
      'prompt.approve',
    );
  }

  async publishPromptVersion(
    organizationId: string,
    promptVersionId: string,
  ): Promise<PromptVersion> {
    return this.telemetry.measure('prompt.publish', () =>
      this.adapter.run(async (context) => {
        const versions = context.repository<PromptVersion>(promptVersionRepository);
        const current = await versions.findById(organizationId, promptVersionId);
        if (current?.lifecycle !== 'APPROVED' || current.approvedGateId === undefined)
          throw new Error('Approved prompt evaluation gate is required for publication');
        const gate = await context
          .repository<PromptEvaluationGate>(promptGateRepository)
          .findById(organizationId, current.approvedGateId);
        if (
          gate === undefined ||
          !gate.passed ||
          gate.promptVersionId !== current.id ||
          gate.promptContentDigest !== current.contentDigest ||
          gate.modelDefinitionId !== current.modelDefinitionId ||
          gate.suiteVersion !== current.evaluationSuiteVersion
        )
          throw new Error('Prompt evaluation gate is stale or failed');
        const updatedAt = this.now();
        const updated = await versions.update(
          { ...current, version: current.version + 1, updatedAt, lifecycle: 'PUBLISHED' },
          current.version,
        );
        await this.appendAudit(
          context,
          organizationId,
          'PROMPT_PUBLISHED',
          'prompt_version',
          current.id,
          { promptId: current.promptId, gateId: gate.id, versionLabel: current.versionLabel },
          updatedAt,
        );
        return updated;
      }),
    );
  }

  listPrompts(organizationId: string, limit = 100) {
    return this.prompts.list(organizationId, { limit });
  }

  listPromptVersions(organizationId: string, promptId: string): Promise<PromptVersion[]> {
    return all(this.promptVersions, organizationId).then((items) =>
      items.filter((item) => item.promptId === promptId),
    );
  }

  getPromptVersion(
    organizationId: string,
    promptVersionId: string,
  ): Promise<PromptVersion | undefined> {
    return this.promptVersions.findById(organizationId, promptVersionId);
  }

  resolve(organizationId: string, idOrAlias: string): Promise<ModelDefinition | undefined> {
    return this.telemetry.measure('model.resolve', () =>
      this.models
        .findById(organizationId, idOrAlias)
        .then(
          async (direct) =>
            direct ??
            (await all(this.models, organizationId)).find(({ aliases }) =>
              aliases.includes(idOrAlias),
            ),
        ),
    );
  }

  listProviders(organizationId: string, limit = 100) {
    return this.providers.list(organizationId, { limit });
  }

  listModels(organizationId: string, limit = 100) {
    return this.models.list(organizationId, { limit });
  }

  getModel(organizationId: string, modelId: string): Promise<ModelDefinition | undefined> {
    return this.models.findById(organizationId, modelId);
  }

  getProvider(organizationId: string, providerId: string): Promise<ProviderDefinition | undefined> {
    return this.providers.findById(organizationId, providerId);
  }

  listAuditEvents(organizationId: string, limit = 100) {
    return this.adapter
      .repository<ModelAuditEvent>(auditRepository)
      .list(organizationId, { limit });
  }

  private async appendAudit(
    context: TransactionContext,
    organizationId: string,
    eventType: ModelAuditEventType,
    resourceType: ModelAuditEvent['resourceType'],
    resourceId: string,
    metadata: ModelAuditEvent['metadata'],
    timestamp = this.now(),
  ): Promise<void> {
    await context.repository<ModelAuditEvent>(auditRepository).insert({
      id: uuidV7(timestamp.getTime()),
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      eventType,
      resourceType,
      resourceId,
      outcome: 'SUCCESS',
      metadata,
    });
  }

  private transitionPromptVersion(
    organizationId: string,
    promptVersionId: string,
    from: PromptVersion['lifecycle'],
    to: PromptVersion['lifecycle'],
    eventType: ModelAuditEventType,
    operation: AiGovernanceOperation,
  ): Promise<PromptVersion> {
    return this.telemetry.measure(operation, () =>
      this.adapter.run(async (context) => {
        const versions = context.repository<PromptVersion>(promptVersionRepository);
        const current = await versions.findById(organizationId, promptVersionId);
        if (
          current?.lifecycle !== from ||
          current.approvedGateId === undefined ||
          to !== 'APPROVED'
        )
          throw new Error('Passing prompt evaluation gate is required');
        const updatedAt = this.now();
        const updated = await versions.update(
          { ...current, version: current.version + 1, updatedAt, lifecycle: to },
          current.version,
        );
        await this.appendAudit(
          context,
          organizationId,
          eventType,
          'prompt_version',
          current.id,
          { promptId: current.promptId, gateId: current.approvedGateId, from, to },
          updatedAt,
        );
        return updated;
      }),
    );
  }

  private promptDigest(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private assertScope(organizationId: string, entity: { tenantId: string }): void {
    if (organizationId.length === 0 || entity.tenantId !== organizationId)
      throw new Error('Invalid organization scope');
  }
}
