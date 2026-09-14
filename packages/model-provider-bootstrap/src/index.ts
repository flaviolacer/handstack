import { ProviderFactoryRegistry, type ProviderFactoryContext } from '@handstack/model-runtime';
import type { ProviderDefinition } from '@handstack/models';
import { createAnthropicProvider } from '@handstack/provider-anthropic';
import { createBedrockProvider, type BedrockTransport } from '@handstack/provider-bedrock';
import { createGeminiProvider } from '@handstack/provider-gemini';
import {
  createAzureOpenAIProvider,
  createOllamaProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
  createVllmProvider,
  OpenAICompatibleProvider,
} from '@handstack/provider-openai-compatible';

export interface OfficialProviderBootstrapOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly bedrockTransport?: (region: string) => BedrockTransport;
}

function setting(definition: ProviderDefinition, key: string, fallback?: string): string {
  const value = definition.configuration?.[key] ?? fallback;
  if (value === undefined || value.trim() === '')
    throw new TypeError(`Provider configuration is missing: ${key}`);
  return value;
}

function compatibleOptions(
  context: ProviderFactoryContext,
  options: OfficialProviderBootstrapOptions,
) {
  return {
    resolveApiKey: context.resolveSecret,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

export function createOfficialProviderFactories(
  options: OfficialProviderBootstrapOptions = {},
): ProviderFactoryRegistry {
  const registry = new ProviderFactoryRegistry();

  registry.register('openai', (context) =>
    createOpenAIProvider({
      ...compatibleOptions(context, options),
      ...(context.definition.baseUrl === undefined ? {} : { baseUrl: context.definition.baseUrl }),
    }),
  );
  registry.register(
    'openai-compatible',
    (context) =>
      new OpenAICompatibleProvider({
        ...compatibleOptions(context, options),
        baseUrl: setting(context.definition, 'baseUrl', context.definition.baseUrl),
      }),
  );
  registry.register('ollama', (context) =>
    createOllamaProvider({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(context.definition.baseUrl === undefined ? {} : { baseUrl: context.definition.baseUrl }),
    }),
  );
  registry.register('vllm', (context) =>
    createVllmProvider({
      ...compatibleOptions(context, options),
      baseUrl: context.definition.baseUrl ?? 'http://127.0.0.1:8000/v1',
    }),
  );
  registry.register('openrouter', (context) =>
    createOpenRouterProvider({
      ...compatibleOptions(context, options),
      ...(context.definition.baseUrl === undefined ? {} : { baseUrl: context.definition.baseUrl }),
      ...(context.definition.configuration?.applicationUrl === undefined
        ? {}
        : { applicationUrl: context.definition.configuration.applicationUrl }),
      ...(context.definition.configuration?.applicationName === undefined
        ? {}
        : { applicationName: context.definition.configuration.applicationName }),
    }),
  );
  registry.register('anthropic', (context) =>
    createAnthropicProvider({
      resolveApiKey: context.resolveSecret,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(context.definition.baseUrl === undefined ? {} : { baseUrl: context.definition.baseUrl }),
    }),
  );
  registry.register('gemini', (context) =>
    createGeminiProvider({
      resolveApiKey: context.resolveSecret,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(context.definition.baseUrl === undefined ? {} : { baseUrl: context.definition.baseUrl }),
    }),
  );
  registry.register('azure-openai', (context) =>
    createAzureOpenAIProvider({
      ...compatibleOptions(context, options),
      resourceName: setting(context.definition, 'resourceName'),
      deployment:
        context.definition.configuration?.deployment ?? context.modelDefinition.providerModel,
      apiVersion: setting(context.definition, 'apiVersion'),
    }),
  );
  registry.register('aws-bedrock', (context) => {
    if (context.definition.secretReference !== undefined)
      throw new TypeError('AWS Bedrock requires workload identity, not a secret reference');
    const region = setting(context.definition, 'region');
    return createBedrockProvider({
      region,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.bedrockTransport === undefined
        ? {}
        : { transport: options.bedrockTransport(region) }),
    });
  });

  return registry;
}
