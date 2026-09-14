import type { ChatEvent, ChatResponse, EmbeddingResponse, LLMProvider } from '@handstack/models';

export interface ProviderContractReport {
  readonly models: readonly string[];
  readonly response: ChatResponse;
  readonly events: readonly ChatEvent[];
}

export interface EmbeddingContractReport {
  readonly response: EmbeddingResponse;
  readonly dimension: number;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`LLMProvider contract violation: ${message}`);
}

export async function verifyLLMProviderContract(
  provider: LLMProvider,
): Promise<ProviderContractReport> {
  const health = await provider.health();
  invariant(['healthy', 'degraded', 'unavailable'].includes(health.status), 'invalid health');
  invariant(!Number.isNaN(health.checkedAt.getTime()), 'invalid health timestamp');
  const models = await provider.listModels();
  invariant(models.length > 0 && models.every((model) => model.length > 0), 'models required');
  const model = models.at(0);
  invariant(model !== undefined, 'models required');
  const request = {
    model,
    messages: [{ role: 'user' as const, content: 'contract probe' }],
    tools: [{ name: 'probe', inputSchema: { type: 'object' } }],
  };
  const response = await provider.chat(request);
  invariant(response.usage.inputTokens >= 0 && response.usage.outputTokens >= 0, 'invalid usage');
  invariant(
    ['stop', 'length', 'tool_call', 'error'].includes(response.finishReason),
    'invalid finish reason',
  );
  const events: ChatEvent[] = [];
  for await (const event of provider.stream(request)) events.push(event);
  invariant(
    events.some(({ type }) => type === 'done'),
    'stream must terminate',
  );
  return { models, response, events };
}

/** Validate the optional embedding capability without requiring a vendor adapter. */
export async function verifyEmbeddingContract(
  provider: LLMProvider,
  model?: string,
): Promise<EmbeddingContractReport> {
  invariant(provider.embed !== undefined, 'embedding capability required');
  const response = await provider.embed({
    model: model ?? (await provider.listModels())[0] ?? '',
    input: ['contract probe'],
  });
  invariant(response.vectors.length === 1, 'one vector required');
  const vector = response.vectors[0];
  invariant(vector !== undefined && vector.length > 0, 'vector dimension required');
  invariant(
    vector.every((value) => Number.isFinite(value)),
    'vector values must be finite',
  );
  invariant(
    Number.isInteger(response.usage.promptTokens) && response.usage.promptTokens >= 0,
    'invalid prompt usage',
  );
  invariant(
    Number.isInteger(response.usage.totalTokens) &&
      response.usage.totalTokens >= response.usage.promptTokens,
    'invalid total usage',
  );
  return { response, dimension: vector.length };
}
