import { verifyLLMProviderContract } from '@handstack/provider-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, AnthropicProviderError } from '../src/index.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const models = { data: [{ id: 'claude-test' }] };
const completion = {
  content: [{ type: 'tool_use', id: 'call-1', name: 'probe', input: { ok: true } }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 6, output_tokens: 2 },
};
const stream = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":6,"output_tokens":0}}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"stream-call","name":"probe","input":{}}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"ok\\":true}"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
  '',
].join('\n\n');

describe('Anthropic provider', () => {
  afterEach(() => vi.useRealTimers());

  it('passes the shared contract and translates system, tools, usage and stream', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(models))
      .mockResolvedValueOnce(json(completion))
      .mockResolvedValueOnce(new Response(stream));
    const provider = new AnthropicProvider({
      resolveApiKey: () => Promise.resolve('secret'),
      fetch: transport,
      now: () => new Date(0),
    });
    const report = await verifyLLMProviderContract(provider);
    expect(report.response).toMatchObject({
      finishReason: 'tool_call',
      usage: { inputTokens: 6, outputTokens: 2 },
      toolCalls: [{ name: 'probe', arguments: { ok: true } }],
    });
    expect(report.events).toEqual([
      { type: 'content', delta: 'hello' },
      {
        type: 'tool_call',
        toolCall: { id: 'stream-call', name: 'probe', arguments: { ok: true } },
      },
      { type: 'usage', usage: { inputTokens: 6, outputTokens: 1 } },
      { type: 'done', finishReason: 'stop' },
    ]);
    const [url, init] = transport.mock.calls[2] as [URL, RequestInit];
    expect(url.href).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toMatchObject({
      'x-api-key': 'secret',
      'anthropic-version': '2023-06-01',
    });
    expect(typeof init.body).toBe('string');
    if (typeof init.body !== 'string') throw new Error('Expected serialized request body');
    expect(init.body).not.toContain('secret');
  });

  it('requires HTTPS and sanitizes HTTP, timeout and cancellation failures', async () => {
    expect(
      () =>
        new AnthropicProvider({
          baseUrl: 'http://example.test',
          resolveApiKey: () => Promise.resolve('x'),
        }),
    ).toThrow(/HTTPS/);
    const failed = new AnthropicProvider({
      resolveApiKey: () => Promise.resolve('secret'),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('private', { status: 429 })),
    });
    const error = await failed.listModels().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AnthropicProviderError);
    expect(error).toMatchObject({ code: 'HTTP', status: 429 });
    expect(JSON.stringify(error)).not.toContain('private');

    const controller = new AbortController();
    controller.abort();
    await expect(
      new AnthropicProvider({
        resolveApiKey: () => Promise.resolve('x'),
        fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('secret')),
      }).chat({ model: 'x', messages: [], signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    vi.useFakeTimers();
    const stalled = new AnthropicProvider({
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
