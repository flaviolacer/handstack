import type { ModelRegistry } from '@handstack/model-registry';
import type {
  AiGovernanceTelemetry,
  ChatEvent,
  ChatMessage,
  ChatResponse,
  DataClassification,
  LLMProvider,
  ModelDefinition,
  ProviderDefinition,
  ProviderHealth,
  ProviderUsage,
  ToolDefinition,
  EmbeddingResponse,
} from '@handstack/models';

export { ModelEvaluationCaseRunner } from './evaluation-runner.js';

export type ModelRuntimeErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'MODEL_NOT_PUBLISHED'
  | 'PROVIDER_UNAVAILABLE'
  | 'CLASSIFICATION_DENIED'
  | 'ADAPTER_NOT_REGISTERED'
  | 'PROVIDER_FAILURE';

export class ModelRuntimeError extends Error {
  constructor(readonly code: ModelRuntimeErrorCode) {
    super(`Model execution failed: ${code}`);
    this.name = 'ModelRuntimeError';
  }
}

export interface SecretResolver {
  resolve(organizationId: string, reference: string): Promise<string | undefined>;
}

export interface ProviderFactoryContext {
  readonly organizationId: string;
  readonly definition: ProviderDefinition;
  readonly modelDefinition: ModelDefinition;
  readonly resolveSecret: () => Promise<string | undefined>;
}

export type ProviderFactory = (context: ProviderFactoryContext) => LLMProvider;

export class ProviderFactoryRegistry {
  private readonly factories = new Map<ProviderDefinition['adapter'], ProviderFactory>();

  register(adapter: ProviderDefinition['adapter'], factory: ProviderFactory): void {
    if (this.factories.has(adapter)) throw new Error('Provider factory already registered');
    this.factories.set(adapter, factory);
  }

  create(adapter: ProviderDefinition['adapter'], context: ProviderFactoryContext): LLMProvider {
    const factory = this.factories.get(adapter);
    if (factory === undefined) throw new ModelRuntimeError('ADAPTER_NOT_REGISTERED');
    return factory(context);
  }

  registeredAdapters(): readonly ProviderDefinition['adapter'][] {
    return [...this.factories.keys()];
  }
}

export interface ModelExecutionInput {
  readonly organizationId: string;
  readonly model: string;
  readonly dataClassification: DataClassification;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly signal?: AbortSignal;
}

export interface ResolvedModelRoute {
  readonly modelDefinitionId: string;
  readonly providerId: string;
  readonly pricing: ModelDefinition['pricing'];
}

export interface UsageObservation extends ProviderUsage {
  readonly organizationId: string;
  readonly providerId: string;
  readonly modelDefinitionId: string;
}

export interface HealthObservation {
  readonly organizationId: string;
  readonly providerId: string;
  readonly health: ProviderHealth;
}

export interface ModelRuntimeObserver {
  recordUsage(observation: UsageObservation): Promise<void> | void;
  recordHealth(observation: HealthObservation): Promise<void> | void;
}

const silentObserver: ModelRuntimeObserver = {
  recordUsage: () => undefined,
  recordHealth: () => undefined,
};

const directTelemetry: AiGovernanceTelemetry = {
  measure: (_operation, work) => work(),
  measureStream: (_operation, work) => work(),
};

interface ResolvedExecution {
  readonly model: ModelDefinition;
  readonly providerDefinition: ProviderDefinition;
  readonly provider: LLMProvider;
}

export class ModelExecutionRuntime {
  private readonly observer: ModelRuntimeObserver;

  constructor(
    private readonly registry: ModelRegistry,
    private readonly factories: ProviderFactoryRegistry,
    private readonly secrets: SecretResolver,
    observer?: ModelRuntimeObserver,
    private readonly telemetry: AiGovernanceTelemetry = directTelemetry,
  ) {
    this.observer = observer ?? silentObserver;
  }

  async chat(input: ModelExecutionInput): Promise<ChatResponse> {
    return this.telemetry.measure('model.chat', () => this.executeChat(input));
  }

  async embed(input: {
    readonly organizationId: string;
    readonly model: string;
    readonly dataClassification: DataClassification;
    readonly input: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<EmbeddingResponse> {
    return this.telemetry.measure('model.embed', async () => {
      const resolved = await this.resolve({
        organizationId: input.organizationId,
        model: input.model,
        dataClassification: input.dataClassification,
        messages: [],
      });
      if (resolved.provider.embed === undefined)
        throw new ModelRuntimeError('ADAPTER_NOT_REGISTERED');
      return resolved.provider.embed({
        model: resolved.model.providerModel,
        input: input.input,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    });
  }

  private async executeChat(input: ModelExecutionInput): Promise<ChatResponse> {
    const resolved = await this.resolve(input);
    await this.observeHealth(input.organizationId, resolved);
    try {
      const response = await resolved.provider.chat(this.request(input, resolved.model));
      await this.observeUsage(input.organizationId, resolved, response.usage);
      return response;
    } catch (error) {
      if (error instanceof ModelRuntimeError) throw error;
      throw new ModelRuntimeError('PROVIDER_FAILURE');
    }
  }

  stream(input: ModelExecutionInput): AsyncIterable<ChatEvent> {
    return this.telemetry.measureStream('model.stream', () => this.executeStream(input));
  }

  async resolveRoute(input: {
    organizationId: string;
    model: string;
    dataClassification: DataClassification;
  }): Promise<ResolvedModelRoute> {
    const model = await this.registry.resolve(input.organizationId, input.model);
    if (model === undefined) throw new ModelRuntimeError('MODEL_NOT_FOUND');
    if (model.lifecycle !== 'PUBLISHED') throw new ModelRuntimeError('MODEL_NOT_PUBLISHED');
    const provider = await this.registry.getProvider(input.organizationId, model.providerId);
    if (provider?.enabled !== true) throw new ModelRuntimeError('PROVIDER_UNAVAILABLE');
    if (!provider.dataClassificationAllowed.includes(input.dataClassification))
      throw new ModelRuntimeError('CLASSIFICATION_DENIED');
    return {
      modelDefinitionId: model.id,
      providerId: provider.id,
      pricing: model.pricing,
    };
  }

  private async *executeStream(input: ModelExecutionInput): AsyncIterable<ChatEvent> {
    const resolved = await this.resolve(input);
    await this.observeHealth(input.organizationId, resolved);
    try {
      for await (const event of resolved.provider.stream(this.request(input, resolved.model))) {
        if (event.type === 'usage')
          await this.observeUsage(input.organizationId, resolved, event.usage);
        yield event;
      }
    } catch (error) {
      if (error instanceof ModelRuntimeError) throw error;
      throw new ModelRuntimeError('PROVIDER_FAILURE');
    }
  }

  private async resolve(input: ModelExecutionInput): Promise<ResolvedExecution> {
    if (input.organizationId === '') throw new ModelRuntimeError('MODEL_NOT_FOUND');
    const model = await this.registry.resolve(input.organizationId, input.model);
    if (model === undefined) throw new ModelRuntimeError('MODEL_NOT_FOUND');
    if (model.lifecycle !== 'PUBLISHED') throw new ModelRuntimeError('MODEL_NOT_PUBLISHED');
    const providerDefinition = await this.registry.getProvider(
      input.organizationId,
      model.providerId,
    );
    if (providerDefinition?.enabled !== true) throw new ModelRuntimeError('PROVIDER_UNAVAILABLE');
    if (!providerDefinition.dataClassificationAllowed.includes(input.dataClassification))
      throw new ModelRuntimeError('CLASSIFICATION_DENIED');
    const resolveSecret = async () => {
      if (providerDefinition.secretReference === undefined) return undefined;
      return this.secrets.resolve(input.organizationId, providerDefinition.secretReference);
    };
    const provider = this.factories.create(providerDefinition.adapter, {
      organizationId: input.organizationId,
      definition: providerDefinition,
      modelDefinition: model,
      resolveSecret,
    });
    return { model, providerDefinition, provider };
  }

  private request(input: ModelExecutionInput, model: ModelDefinition) {
    return {
      model: model.providerModel,
      messages: input.messages,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }

  private async observeHealth(organizationId: string, resolved: ResolvedExecution): Promise<void> {
    let health: ProviderHealth;
    try {
      health = await resolved.provider.health();
    } catch {
      throw new ModelRuntimeError('PROVIDER_UNAVAILABLE');
    }
    await this.observer.recordHealth({
      organizationId,
      providerId: resolved.providerDefinition.id,
      health,
    });
    if (health.status === 'unavailable') throw new ModelRuntimeError('PROVIDER_UNAVAILABLE');
  }

  private observeUsage(
    organizationId: string,
    resolved: ResolvedExecution,
    usage: ProviderUsage,
  ): Promise<void> {
    return Promise.resolve(
      this.observer.recordUsage({
        organizationId,
        providerId: resolved.providerDefinition.id,
        modelDefinitionId: resolved.model.id,
        ...usage,
      }),
    );
  }
}
