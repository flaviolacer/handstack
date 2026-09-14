import type { ProviderFactoryContext } from '@handstack/model-runtime';
import type { ModelDefinition, ProviderDefinition } from '@handstack/models';
import { AnthropicProvider } from '@handstack/provider-anthropic';
import { BedrockProvider } from '@handstack/provider-bedrock';
import { GeminiProvider } from '@handstack/provider-gemini';
import { OpenAICompatibleProvider } from '@handstack/provider-openai-compatible';
import { describe, expect, it, vi } from 'vitest';
import { createOfficialProviderFactories } from '../src/index.js';

const adapters: readonly ProviderDefinition['adapter'][] = [
  'openai',
  'anthropic',
  'gemini',
  'azure-openai',
  'aws-bedrock',
  'openrouter',
  'ollama',
  'vllm',
  'openai-compatible',
];
const now = new Date(0);
const modelDefinition: ModelDefinition = {
  id: 'model',
  tenantId: 'org',
  organizationId: 'org',
  version: 1,
  createdAt: now,
  updatedAt: now,
  displayName: 'Model',
  providerId: 'provider',
  providerModel: 'vendor-model',
  aliases: ['model'],
  capabilities: ['chat'],
  contextWindow: 1000,
  pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
  lifecycle: 'PUBLISHED',
};

function context(adapter: ProviderDefinition['adapter']): ProviderFactoryContext {
  const configuration: Record<string, string> =
    adapter === 'azure-openai'
      ? { resourceName: 'resource', apiVersion: 'version' }
      : adapter === 'aws-bedrock'
        ? { region: 'us-east-1' }
        : {};
  return {
    organizationId: 'org',
    modelDefinition,
    resolveSecret: () => Promise.resolve('secret'),
    definition: {
      id: 'provider',
      tenantId: 'org',
      organizationId: 'org',
      version: 1,
      createdAt: now,
      updatedAt: now,
      name: adapter,
      adapter,
      enabled: true,
      ...(adapter === 'openai-compatible' ? { baseUrl: 'https://compatible.example.test/v1' } : {}),
      ...(adapter === 'aws-bedrock' || adapter === 'ollama'
        ? {}
        : { secretReference: 'vault://key' }),
      configuration,
      dataClassificationAllowed: ['PUBLIC'],
    },
  };
}

describe('official provider bootstrap', () => {
  it('registers every initial adapter and constructs the expected provider without resolving secrets', () => {
    let resolutions = 0;
    const registry = createOfficialProviderFactories({
      fetch: vi.fn(),
      bedrockTransport: () => ({
        listFoundationModels: () => Promise.resolve({ modelSummaries: [] }),
        converse: () => Promise.reject(new Error('unused')),
        converseStream: () => Promise.reject(new Error('unused')),
      }),
    });
    expect([...registry.registeredAdapters()].sort()).toEqual([...adapters].sort());
    for (const adapter of adapters) {
      const item = context(adapter);
      const provider = registry.create(adapter, {
        ...item,
        resolveSecret: () => {
          resolutions += 1;
          return Promise.resolve('secret');
        },
      });
      if (adapter === 'anthropic') expect(provider).toBeInstanceOf(AnthropicProvider);
      else if (adapter === 'gemini') expect(provider).toBeInstanceOf(GeminiProvider);
      else if (adapter === 'aws-bedrock') expect(provider).toBeInstanceOf(BedrockProvider);
      else expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    }
    expect(resolutions).toBe(0);
  });

  it('fails fast for missing public configuration and Bedrock secret references', () => {
    const registry = createOfficialProviderFactories();
    const compatible = context('openai-compatible');
    const { baseUrl: _baseUrl, ...compatibleWithoutBaseUrl } = compatible.definition;
    expect(_baseUrl).toBe('https://compatible.example.test/v1');
    expect(() =>
      registry.create('azure-openai', {
        ...context('azure-openai'),
        definition: { ...context('azure-openai').definition, configuration: {} },
      }),
    ).toThrow(/resourceName/);
    expect(() =>
      registry.create('openai-compatible', {
        ...compatible,
        definition: compatibleWithoutBaseUrl,
      }),
    ).toThrow(/baseUrl/);
    expect(() =>
      registry.create('aws-bedrock', {
        ...context('aws-bedrock'),
        definition: { ...context('aws-bedrock').definition, secretReference: 'vault://aws' },
      }),
    ).toThrow(/workload identity/);
  });
});
