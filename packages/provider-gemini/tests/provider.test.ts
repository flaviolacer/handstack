import { verifyLLMProviderContract } from '@handstack/provider-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider, GeminiProviderError } from '../src/index.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const models = { models: [{ name: 'models/gemini-test' }] };
const completion = {
  candidates: [
    {
      content: { parts: [{ functionCall: { name: 'probe', args: { ok: true } } }] },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
};
const stream = [
  'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}}',
  'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}}',
  '',
].join('\n');

describe('Gemini provider', () => {
  afterEach(() => vi.useRealTimers());
  it('passes the shared contract and translates tools, usage and SSE', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(completion))
      .mockResolvedValueOnce(new Response(stream));
    const provider = new GeminiProvider({
      resolveApiKey: () => Promise.resolve('secret'),
      fetch: transport,
      now: () => new Date(0),
    });
    const report = await verifyLLMProviderContract(provider);
    expect(report.response).toMatchObject({
      finishReason: 'tool_call',
      usage: { inputTokens: 5, outputTokens: 2 },
      toolCalls: [{ name: 'probe', arguments: { ok: true } }],
    });
    expect(report.events).toEqual([
      { type: 'content', delta: 'hello' },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } },
      { type: 'done', finishReason: 'stop' },
    ]);
    const [url, init] = transport.mock.calls[2] as [URL, RequestInit];
    expect(url.href).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent',
    );
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'secret' });
    expect(typeof init.body).toBe('string');
    if (typeof init.body !== 'string') throw new Error('Expected serialized request body');
    expect(init.body).not.toContain('secret');
  });
  it('requires HTTPS and emits closed timeout, cancellation and HTTP errors', async () => {
    expect(
      () =>
        new GeminiProvider({
          baseUrl: 'http://example.test',
          resolveApiKey: () => Promise.resolve('x'),
        }),
    ).toThrow(/HTTPS/);
    const failed = new GeminiProvider({
      resolveApiKey: () => Promise.resolve('x'),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('private', { status: 503 })),
    });
    const error = await failed.listModels().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GeminiProviderError);
    expect(error).toMatchObject({ code: 'HTTP', status: 503 });
    expect(JSON.stringify(error)).not.toContain('private');
    const controller = new AbortController();
    controller.abort();
    await expect(
      new GeminiProvider({
        resolveApiKey: () => Promise.resolve('x'),
        fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('private')),
      }).chat({ model: 'x', messages: [], signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    vi.useFakeTimers();
    const stalled = new GeminiProvider({
      timeoutMs: 5,
      resolveApiKey: () => Promise.resolve('x'),
      fetch: vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new Error('private'));
            });
          }),
      ),
    });
    const pending = expect(stalled.listModels()).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(5);
    await pending;
  });
});
