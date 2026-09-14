import { verifyLLMProviderContract } from '@handstack/provider-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAzureOpenAIProvider,
  createOllamaProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
  createVllmProvider,
  OpenAICompatibleProvider,
  ProviderRequestError,
} from '../src/index.js';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const modelList = { data: [{ id: 'vendor-model' }] };
const completion = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [{ id: 'call-1', function: { name: 'probe', arguments: '{"ok":true}' } }],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 2 },
};
const sse = [
  'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
  'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  '',
].join('\n');

describe('OpenAI-compatible provider', () => {
  afterEach(() => vi.useRealTimers());

  it('passes the shared models, health, chat, tools, stream and usage contract', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(modelList))
      .mockResolvedValueOnce(json(modelList))
      .mockResolvedValueOnce(json(completion))
      .mockResolvedValueOnce(
        new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example.test/v1',
      resolveApiKey: () => Promise.resolve('private-key'),
      fetch: transport,
      now: () => new Date(0),
    });
    const report = await verifyLLMProviderContract(provider);
    expect(report.response).toMatchObject({
      finishReason: 'tool_call',
      usage: { inputTokens: 4, outputTokens: 2 },
      toolCalls: [{ name: 'probe', arguments: { ok: true } }],
    });
    expect(report.events).toEqual([
      { type: 'content', delta: 'hello' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 1 } },
      { type: 'done', finishReason: 'stop' },
    ]);
    const [url, init] = transport.mock.calls[2] as [URL, RequestInit];
    expect(url.href).toBe('https://provider.example.test/v1/chat/completions');
    expect(init.headers).toMatchObject({ authorization: 'Bearer private-key' });
    expect(typeof init.body).toBe('string');
    if (typeof init.body !== 'string') throw new Error('Expected serialized request body');
    expect(init.body).not.toContain('private-key');
  });

  it('allows explicit loopback HTTP for Ollama but rejects insecure remote URLs', () => {
    expect(
      () => new OpenAICompatibleProvider({ baseUrl: 'http://remote.example.test/v1' }),
    ).toThrow(/HTTPS/);
    expect(
      () =>
        new OpenAICompatibleProvider({
          baseUrl: 'http://127.0.0.1:11434/v1',
          allowInsecureLocalhost: true,
        }),
    ).not.toThrow();
    expect(createOpenAIProvider({ fetch: vi.fn() })).toBeInstanceOf(OpenAICompatibleProvider);
    expect(createOllamaProvider({ fetch: vi.fn() })).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('maps timeout and HTTP failures to closed errors without response details', async () => {
    vi.useFakeTimers();
    const stalled = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted === true) {
            reject(new Error('secret network detail'));
            return;
          }
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('secret network detail'));
          });
        }),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example.test/v1',
      fetch: stalled,
      timeoutMs: 10,
    });
    const pending = provider.listModels();
    const timeoutAssertion = expect(pending).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Provider request failed: TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(10);
    await timeoutAssertion;

    const failed = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example.test/v1',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('private upstream body', { status: 429 })),
    });
    const error = await failed.listModels().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error).toMatchObject({ code: 'HTTP', status: 429 });
    expect(JSON.stringify(error)).not.toContain('private upstream body');

    const controller = new AbortController();
    controller.abort();
    const cancelled = new OpenAICompatibleProvider({
      baseUrl: 'https://provider.example.test/v1',
      fetch: stalled,
    });
    await expect(
      cancelled.chat({ model: 'vendor-model', messages: [], signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('specializes Azure OpenAI, OpenRouter and loopback vLLM through the shared contract', async () => {
    const azureTransport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(completion))
      .mockResolvedValueOnce(new Response(sse));
    const azure = createAzureOpenAIProvider({
      resourceName: 'handstack-test',
      deployment: 'gpt-deployment',
      apiVersion: 'contract-version',
      resolveApiKey: () => Promise.resolve('azure-secret'),
      fetch: azureTransport,
      now: () => new Date(0),
    });
    await verifyLLMProviderContract(azure);
    const [azureUrl, azureInit] = azureTransport.mock.calls[0] as [URL, RequestInit];
    expect(azureUrl.href).toBe(
      'https://handstack-test.openai.azure.com/openai/deployments/gpt-deployment/chat/completions?api-version=contract-version',
    );
    expect(azureInit.headers).toMatchObject({ 'api-key': 'azure-secret' });
    expect(azureInit.headers).not.toHaveProperty('authorization');

    const compatibleTransport = () =>
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(modelList))
        .mockResolvedValueOnce(json(modelList))
        .mockResolvedValueOnce(json(completion))
        .mockResolvedValueOnce(new Response(sse));
    const openRouterTransport = compatibleTransport();
    await verifyLLMProviderContract(
      createOpenRouterProvider({
        resolveApiKey: () => Promise.resolve('router-secret'),
        applicationUrl: 'https://handstack.example.test',
        applicationName: 'HandStack',
        fetch: openRouterTransport,
        now: () => new Date(0),
      }),
    );
    expect((openRouterTransport.mock.calls[2] as [URL, RequestInit])[1].headers).toMatchObject({
      authorization: 'Bearer router-secret',
      'HTTP-Referer': 'https://handstack.example.test',
      'X-Title': 'HandStack',
    });

    const vllmTransport = compatibleTransport();
    await verifyLLMProviderContract(
      createVllmProvider({
        baseUrl: 'http://127.0.0.1:8000/v1',
        fetch: vllmTransport,
        now: () => new Date(0),
      }),
    );
    expect((vllmTransport.mock.calls[2] as [URL])[0].href).toBe(
      'http://127.0.0.1:8000/v1/chat/completions',
    );
    expect(() =>
      createVllmProvider({ baseUrl: 'http://remote.example.test/v1', fetch: vi.fn() }),
    ).toThrow(/HTTPS/);
  });
});
