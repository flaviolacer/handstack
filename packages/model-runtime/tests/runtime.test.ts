import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter, type DatabaseAdapter } from '@handstack/database';
import { ModelRegistry } from '@handstack/model-registry';
import type {
  AiGovernanceTelemetry,
  ChatEvent,
  ChatRequest,
  EvaluationGate,
  LLMProvider,
  ModelDefinition,
  ProviderDefinition,
} from '@handstack/models';
import { describe, expect, it } from 'vitest';
import {
  ModelExecutionRuntime,
  ModelRuntimeError,
  ProviderFactoryRegistry,
  type HealthObservation,
  type UsageObservation,
} from '../src/index.js';

const organizationId = 'runtime-organization';
const now = new Date('2026-09-01T15:00:00.000Z');
const base = (id: string) => ({
  id,
  tenantId: organizationId,
  organizationId,
  version: 1,
  createdAt: now,
  updatedAt: now,
});

async function publishedRegistry(): Promise<{ adapter: DatabaseAdapter; registry: ModelRegistry }> {
  const adapter = createDatabaseAdapter(
    defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
  );
  await adapter.initialize();
  const registry = new ModelRegistry(adapter, {
    run: () => Promise.reject(new Error('not used by runtime fixture')),
    validateGate: ({ result }) =>
      Promise.resolve({ passed: result.runId === 'runtime-run' && result.passed, reasons: [] }),
  });
  const provider: ProviderDefinition = {
    ...base('provider'),
    name: 'Runtime provider',
    adapter: 'openai',
    enabled: true,
    secretReference: 'vault://runtime-key',
    dataClassificationAllowed: ['PUBLIC', 'INTERNAL'],
  };
  const model: ModelDefinition = {
    ...base('model'),
    displayName: 'Runtime model',
    providerId: provider.id,
    providerModel: 'vendor-model',
    aliases: ['runtime'],
    capabilities: ['chat', 'tools'],
    contextWindow: 10_000,
    pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
    lifecycle: 'DRAFT',
  };
  const gate: EvaluationGate = {
    ...base('gate'),
    modelDefinitionId: model.id,
    suiteId: 'runtime-gate',
    suiteVersion: '1',
    datasetVersion: 'runtime-dataset-v1',
    runId: 'runtime-run',
    passed: true,
    evaluatedAt: now,
    scores: { safety: 1 },
  };
  await registry.registerProvider(provider);
  await registry.registerModel(model);
  await registry.recordGate(gate, {
    runId: gate.runId,
    datasetVersion: gate.datasetVersion,
    passed: gate.passed,
    scores: gate.scores,
  });
  await registry.approve(organizationId, model.id);
  await registry.publish(organizationId, model.id);
  return { adapter, registry };
}

class RuntimeProvider implements LLMProvider {
  readonly requests: ChatRequest[] = [];
  constructor(private readonly resolveSecret: () => Promise<string | undefined>) {}
  health() {
    return Promise.resolve({ status: 'healthy' as const, checkedAt: now });
  }
  listModels() {
    return Promise.resolve(['vendor-model']);
  }
  async chat(request: ChatRequest) {
    if ((await this.resolveSecret()) !== 'secret-value') throw new Error('missing secret');
    this.requests.push(request);
    return {
      content: 'ok',
      finishReason: 'stop' as const,
      usage: { inputTokens: 3, outputTokens: 1 },
    };
  }
  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    if ((await this.resolveSecret()) !== 'secret-value') throw new Error('missing secret');
    this.requests.push(request);
    yield { type: 'content', delta: 'ok' };
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } };
    yield { type: 'done', finishReason: 'stop' };
  }
  embed(request: { readonly model: string; readonly input: readonly string[] }) {
    return Promise.resolve({
      vectors: request.input.map((value) => [value.length / 10]),
      usage: { promptTokens: request.input.length, totalTokens: request.input.length },
    });
  }
}

describe('model execution runtime', () => {
  it('resolves a published tenant alias, secret reference and vendor model for chat/stream', async () => {
    const { adapter, registry } = await publishedRegistry();
    try {
      const factories = new ProviderFactoryRegistry();
      const providers: RuntimeProvider[] = [];
      const secretRequests: string[] = [];
      factories.register('openai', (context) => {
        const provider = new RuntimeProvider(context.resolveSecret);
        providers.push(provider);
        return provider;
      });
      const usage: UsageObservation[] = [];
      const health: HealthObservation[] = [];
      const operations: string[] = [];
      const telemetry: AiGovernanceTelemetry = {
        measure: async (operation, work) => {
          operations.push(operation);
          return work();
        },
        measureStream: (operation, work) => {
          operations.push(operation);
          return work();
        },
      };
      const runtime = new ModelExecutionRuntime(
        registry,
        factories,
        {
          resolve: (tenant, reference) => {
            secretRequests.push(`${tenant}:${reference}`);
            return Promise.resolve('secret-value');
          },
        },
        {
          recordUsage: (item) => {
            usage.push(item);
          },
          recordHealth: (item) => {
            health.push(item);
          },
        },
        telemetry,
      );
      await expect(
        runtime.resolveRoute({
          organizationId,
          model: 'runtime',
          dataClassification: 'INTERNAL',
        }),
      ).resolves.toEqual({
        modelDefinitionId: 'model',
        providerId: 'provider',
        pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
      });
      await expect(
        runtime.resolveRoute({
          organizationId,
          model: 'runtime',
          dataClassification: 'INTERNAL',
        }),
      ).resolves.toEqual({
        modelDefinitionId: 'model',
        providerId: 'provider',
        pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
      });
      await expect(
        runtime.chat({
          organizationId,
          model: 'runtime',
          dataClassification: 'INTERNAL',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      ).resolves.toMatchObject({ content: 'ok' });
      await expect(
        runtime.embed({
          organizationId,
          model: 'runtime',
          dataClassification: 'PUBLIC',
          input: ['hello', 'world'],
        }),
      ).resolves.toEqual({ vectors: [[0.5], [0.5]], usage: { promptTokens: 2, totalTokens: 2 } });
      const events: ChatEvent[] = [];
      for await (const event of runtime.stream({
        organizationId,
        model: 'model',
        dataClassification: 'PUBLIC',
        messages: [{ role: 'user', content: 'stream' }],
      }))
        events.push(event);
      expect(providers.flatMap(({ requests }) => requests.map(({ model }) => model))).toEqual([
        'vendor-model',
        'vendor-model',
      ]);
      expect(secretRequests).toEqual([
        `${organizationId}:vault://runtime-key`,
        `${organizationId}:vault://runtime-key`,
      ]);
      expect(usage).toHaveLength(2);
      expect(health).toHaveLength(2);
      expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
      expect(operations).toEqual(['model.chat', 'model.embed', 'model.stream']);
      expect(JSON.stringify({ usage, health })).not.toContain('secret-value');
    } finally {
      await adapter.close();
    }
  });

  it('fails closed for tenant, lifecycle, classification and unknown factory before provider traffic', async () => {
    const { adapter, registry } = await publishedRegistry();
    try {
      const factories = new ProviderFactoryRegistry();
      let creations = 0;
      factories.register('openai', (context) => {
        creations += 1;
        return new RuntimeProvider(context.resolveSecret);
      });
      expect(() => {
        factories.register('openai', () => new RuntimeProvider(() => Promise.resolve(undefined)));
      }).toThrow(/already/);
      const runtime = new ModelExecutionRuntime(registry, factories, {
        resolve: () => Promise.resolve('secret-value'),
      });
      await expect(
        runtime.chat({
          organizationId: 'other',
          model: 'runtime',
          dataClassification: 'PUBLIC',
          messages: [],
        }),
      ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
      await expect(
        runtime.chat({
          organizationId,
          model: 'runtime',
          dataClassification: 'RESTRICTED',
          messages: [],
        }),
      ).rejects.toMatchObject({ code: 'CLASSIFICATION_DENIED' });
      expect(creations).toBe(0);

      const missingFactories = new ModelExecutionRuntime(registry, new ProviderFactoryRegistry(), {
        resolve: () => Promise.resolve(undefined),
      });
      const error = await missingFactories
        .chat({ organizationId, model: 'runtime', dataClassification: 'PUBLIC', messages: [] })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ModelRuntimeError);
      expect(error).toMatchObject({ code: 'ADAPTER_NOT_REGISTERED' });
    } finally {
      await adapter.close();
    }
  });
});
