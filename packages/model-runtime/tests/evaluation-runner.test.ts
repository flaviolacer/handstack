import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import type { EvaluationDataset, EvaluationSuite } from '@handstack/evaluation';
import { ModelRegistry } from '@handstack/model-registry';
import type {
  ChatRequest,
  LLMProvider,
  ModelDefinition,
  ProviderDefinition,
  Prompt,
  PromptVersion,
} from '@handstack/models';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ModelEvaluationCaseRunner, ProviderFactoryRegistry } from '../src/index.js';

const organizationId = 'evaluation-runtime-organization';
const now = new Date('2026-09-01T18:00:00.000Z');
const base = (id: string) => ({
  id,
  tenantId: organizationId,
  organizationId,
  version: 1,
  createdAt: now,
  updatedAt: now,
});

class CandidateProvider implements LLMProvider {
  readonly requests: ChatRequest[] = [];
  constructor(private readonly secret: () => Promise<string | undefined>) {}
  health() {
    return Promise.resolve({ status: 'healthy' as const, checkedAt: now });
  }
  listModels() {
    return Promise.resolve(['vendor-candidate']);
  }
  async chat(request: ChatRequest) {
    if ((await this.secret()) !== 'resolved-secret') throw new Error('secret unavailable');
    this.requests.push(request);
    return {
      content: '{"answer":"approved"}',
      finishReason: 'tool_call' as const,
      usage: { inputTokens: 20, outputTokens: 10 },
      toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { id: 7, nested: { ok: true } } }],
    };
  }
  async *stream() {
    await Promise.resolve();
    yield { type: 'done' as const, finishReason: 'stop' as const };
  }
}

describe('model evaluation case runner', () => {
  it('executes a draft through its real factory and derives bounded scores from the response', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const registry = new ModelRegistry(adapter);
      const provider: ProviderDefinition = {
        ...base('provider'),
        name: 'Candidate provider',
        adapter: 'openai',
        enabled: true,
        secretReference: 'env://HANDSTACK_SECRET_CANDIDATE',
        dataClassificationAllowed: ['INTERNAL'],
      };
      const model: ModelDefinition = {
        ...base('model'),
        displayName: 'Candidate',
        providerId: provider.id,
        providerModel: 'vendor-candidate',
        aliases: [],
        capabilities: ['chat', 'tools'],
        contextWindow: 4096,
        pricing: { inputPerMillion: 2, outputPerMillion: 4, currency: 'USD' },
        lifecycle: 'DRAFT',
      };
      await registry.registerProvider(provider);
      await registry.registerModel(model);
      const prompt: Prompt = {
        ...base('prompt'),
        name: 'Evaluation prompt',
        slug: 'evaluation-prompt',
      };
      const promptContent = 'Answer {{question}} for {{audience}}';
      const promptVersion: PromptVersion = {
        ...base('prompt-v1'),
        promptId: prompt.id,
        versionLabel: '1.0.0',
        content: promptContent,
        contentDigest: createHash('sha256').update(promptContent).digest('hex'),
        variables: [
          { name: 'question', required: true },
          { name: 'audience', required: false, defaultValue: 'everyone' },
        ],
        modelDefinitionId: model.id,
        lifecycle: 'DRAFT',
      };
      await registry.registerPrompt(prompt);
      await registry.registerPromptVersion(promptVersion);
      const factories = new ProviderFactoryRegistry();
      const providers: CandidateProvider[] = [];
      factories.register('openai', (context) => {
        const candidate = new CandidateProvider(context.resolveSecret);
        providers.push(candidate);
        return candidate;
      });
      const secretRequests: string[] = [];
      const ticks = [100, 125];
      const runner = new ModelEvaluationCaseRunner(
        registry,
        factories,
        {
          resolve: (tenant, reference) => {
            secretRequests.push(`${tenant}:${reference}`);
            return Promise.resolve('resolved-secret');
          },
        },
        () => ticks.shift() ?? 125,
      );
      const dataset: EvaluationDataset = {
        ...base('dataset'),
        name: 'Synthetic',
        datasetVersion: 'dataset-v1',
        classification: 'INTERNAL',
        provenance: 'test generator',
        owner: 'ai-platform',
        retentionDays: 30,
        sourceKind: 'SYNTHETIC',
        approvedForEvaluation: true,
        sanitized: true,
        cases: [],
      };
      const suite: EvaluationSuite = {
        ...base('suite'),
        name: 'Gate',
        suiteVersion: 'suite-v1',
        datasetId: dataset.id,
        datasetVersion: dataset.datasetVersion,
        criteria: [],
      };
      const result = await runner.runCase({
        organizationId,
        modelDefinitionId: model.id,
        promptVersionId: promptVersion.id,
        promptContentDigest: promptVersion.contentDigest,
        dataset,
        suite,
        evaluationCase: {
          id: 'case-1',
          input: {
            variables: { question: 'billing' },
            messages: [{ role: 'user', content: 'answer safely' }],
            tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
          },
          expected: {
            content: '{"answer":"approved"}',
            contentIncludes: ['approved'],
            contentExcludes: ['sk-forbidden-secret-value'],
            jsonObject: true,
            toolCalls: [{ name: 'lookup', arguments: { nested: { ok: true }, id: 7 } }],
          },
        },
      });
      expect(result.scores).toEqual({
        task_success: 1,
        schema_validity: 1,
        tool_selection_correctness: 1,
        tool_argument_correctness: 1,
        safety_policy_compliance: 1,
        prompt_injection_resistance: 1,
        pii_secret_leakage: 0,
        latency_ms: 25,
        token_usage: 30,
        cost_usd: 0.00008,
      });
      expect(providers[0]?.requests[0]?.model).toBe('vendor-candidate');
      expect(providers[0]?.requests[0]?.messages[0]).toEqual({
        role: 'system',
        content: 'Answer billing for everyone',
      });
      expect(secretRequests).toEqual([`${organizationId}:env://HANDSTACK_SECRET_CANDIDATE`]);
      expect(JSON.stringify(result)).not.toContain('resolved-secret');
    } finally {
      await adapter.close();
    }
  });
});
