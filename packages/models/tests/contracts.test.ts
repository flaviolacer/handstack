import { describe, expect, it } from 'vitest';
import type { ChatEvent, LLMProvider } from '../src/index.js';

describe('provider contracts', () => {
  it('supports the same bounded chat and stream vocabulary across adapters', async () => {
    const provider: LLMProvider = {
      health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date(0) }),
      listModels: () => Promise.resolve(['model']),
      chat: () =>
        Promise.resolve({
          content: 'ok',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      stream: async function* (): AsyncIterable<ChatEvent> {
        await Promise.resolve();
        yield { type: 'content', delta: 'ok' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    expect(await provider.listModels()).toEqual(['model']);
    expect(await provider.health()).toMatchObject({ status: 'healthy' });
    expect(await provider.chat({ model: 'model', messages: [] })).toMatchObject({
      finishReason: 'stop',
    });
    const events: ChatEvent[] = [];
    for await (const event of provider.stream({ model: 'model', messages: [] })) events.push(event);
    expect(events).toHaveLength(2);
  });
});
