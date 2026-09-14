import { verifyLLMProviderContract } from '@handstack/provider-testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AwsSdkBedrockTransport,
  BedrockProvider,
  BedrockProviderError,
  type BedrockTransport,
} from '../src/index.js';

function fixture(): {
  transport: BedrockTransport;
  requests: Readonly<Record<string, unknown>>[];
} {
  const requests: Readonly<Record<string, unknown>>[] = [];
  return {
    requests,
    transport: {
      listFoundationModels: () =>
        Promise.resolve({ modelSummaries: [{ modelId: 'bedrock-model' }] }),
      converse: (input: Readonly<Record<string, unknown>>) => {
        requests.push(input);
        return Promise.resolve({
          output: {
            message: {
              content: [{ toolUse: { toolUseId: 'call-1', name: 'probe', input: { ok: true } } }],
            },
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 7, outputTokens: 3 },
        });
      },
      converseStream: () =>
        Promise.resolve(
          (async function* () {
            await Promise.resolve();
            yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hello' } } };
            yield {
              contentBlockStart: {
                contentBlockIndex: 1,
                start: { toolUse: { toolUseId: 'stream-call', name: 'probe' } },
              },
            };
            yield {
              contentBlockDelta: {
                contentBlockIndex: 1,
                delta: { toolUse: { input: '{"ok":true}' } },
              },
            };
            yield { contentBlockStop: { contentBlockIndex: 1 } };
            yield { metadata: { usage: { inputTokens: 7, outputTokens: 2 } } };
            yield { messageStop: { stopReason: 'end_turn' } };
          })(),
        ),
    },
  };
}

describe('AWS Bedrock provider', () => {
  afterEach(() => vi.useRealTimers());

  it('passes discovery, health, Converse, tools, stream, usage and finish contract', async () => {
    const native = fixture();
    const provider = new BedrockProvider({
      region: 'us-east-1',
      transport: native.transport,
      now: () => new Date(0),
    });
    const report = await verifyLLMProviderContract(provider);
    expect(report.response).toMatchObject({
      finishReason: 'tool_call',
      usage: { inputTokens: 7, outputTokens: 3 },
      toolCalls: [{ name: 'probe', arguments: { ok: true } }],
    });
    expect(report.events).toEqual([
      { type: 'content', delta: 'hello' },
      {
        type: 'tool_call',
        toolCall: { id: 'stream-call', name: 'probe', arguments: { ok: true } },
      },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 2 } },
      { type: 'done', finishReason: 'stop' },
    ]);
    expect(native.requests[0]).toMatchObject({ modelId: 'bedrock-model' });
    expect(native.requests[0]?.toolConfig).toBeDefined();
  });

  it('uses the AWS SDK transport by default and sanitizes timeout and cancellation', async () => {
    expect(() => new AwsSdkBedrockTransport('')).toThrow(/region/);
    expect(new BedrockProvider({ region: 'us-east-1' })).toBeInstanceOf(BedrockProvider);
    vi.useFakeTimers();
    const stalled: BedrockTransport = {
      ...fixture().transport,
      listFoundationModels: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('AWS secret detail'));
          });
        }),
    };
    const timed = new BedrockProvider({
      region: 'us-east-1',
      transport: stalled,
      timeoutMs: 5,
    });
    const pending = expect(timed.listModels()).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Bedrock provider request failed: TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(5);
    await pending;

    const controller = new AbortController();
    controller.abort();
    const cancelled = new BedrockProvider({
      region: 'us-east-1',
      transport: {
        ...fixture().transport,
        converse: () => Promise.reject(new Error('private')),
      },
    });
    const error = await cancelled
      .chat({ model: 'x', messages: [], signal: controller.signal })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BedrockProviderError);
    expect(error).toMatchObject({ code: 'CANCELLED' });
    expect(JSON.stringify(error)).not.toContain('private');
  });
});
