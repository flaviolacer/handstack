import type { LLMProvider } from '@handstack/models';
import { describe, expect, it } from 'vitest';
import { verifyEmbeddingContract, verifyLLMProviderContract } from '../src/index.js';

describe('LLM provider test kit', () => {
  it('rejects incomplete implementations', async () => {
    const invalid: LLMProvider = {
      health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date(0) }),
      listModels: () => Promise.resolve([]),
      chat: () =>
        Promise.resolve({
          content: '',
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      stream: async function* () {
        await Promise.resolve();
        yield { type: 'done' as const, finishReason: 'stop' as const };
      },
    };
    await expect(verifyLLMProviderContract(invalid)).rejects.toThrow(/models required/);
  });

  it('validates provider-backed embeddings and fails closed when unsupported', async () => {
    const provider: LLMProvider = {
      health: () => Promise.resolve({ status: 'healthy', checkedAt: new Date(0) }),
      listModels: () => Promise.resolve(['embed-model']),
      chat: () =>
        Promise.resolve({
          content: 'ok',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      stream: async function* () {
        await Promise.resolve();
        yield { type: 'done' as const, finishReason: 'stop' as const };
      },
      embed: () =>
        Promise.resolve({ vectors: [[0.1, 0.2]], usage: { promptTokens: 2, totalTokens: 2 } }),
    };
    await expect(verifyEmbeddingContract(provider)).resolves.toMatchObject({ dimension: 2 });
    const unsupported = { ...provider } as Partial<LLMProvider>;
    Reflect.deleteProperty(unsupported, 'embed');
    await expect(verifyEmbeddingContract(unsupported as LLMProvider)).rejects.toThrow(
      /capability required/,
    );
  });
});
