import { describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleController } from '../src/gateway/openai-compatible.controller.js';

function harness(embed: () => Promise<unknown>) {
  const calls = { reserve: vi.fn(), settle: vi.fn() };
  const gateway = {
    keys: {
      authenticate: vi.fn().mockResolvedValue({ id: 'key', organizationId: 'org', models: [] }),
      reserveBudget: calls.reserve.mockResolvedValue(undefined),
      settleBudget: calls.settle.mockResolvedValue(undefined),
    },
  };
  const models = {
    execution: {
      resolveRoute: vi
        .fn()
        .mockResolvedValue({ pricing: { inputPerMillion: 2, outputPerMillion: 4 } }),
      embed: vi.fn(embed),
    },
  };
  return {
    controller: new OpenAiCompatibleController(gateway as never, models as never),
    calls,
    models,
  };
}

describe('OpenAI-compatible embeddings budget boundary', () => {
  it('reserves estimated input and settles provider-reported prompt usage', async () => {
    const { controller, calls } = harness(() =>
      Promise.resolve({ vectors: [[0.1]], usage: { promptTokens: 3, totalTokens: 3 } }),
    );
    await expect(
      controller.embeddings('Bearer hs_test_secret', { model: 'embed', input: 'hello world' }),
    ).resolves.toMatchObject({ usage: { prompt_tokens: 3, total_tokens: 3 } });
    expect(calls.reserve).toHaveBeenCalledWith('org', 'key', 0.000006);
    expect(calls.settle).toHaveBeenCalledWith('org', 'key', 0.000006, 0.000006);
  });

  it('releases the reservation when the provider fails', async () => {
    const { controller, calls } = harness(() => Promise.reject(new Error('provider down')));
    await expect(
      controller.embeddings('Bearer hs_test_secret', { model: 'embed', input: 'hello' }),
    ).rejects.toThrow('provider down');
    expect(calls.settle).toHaveBeenCalledWith('org', 'key', 0.000004, 0);
  });
});
