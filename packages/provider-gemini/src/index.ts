import type {
  ChatEvent,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ProviderHealth,
  ProviderUsage,
  ToolCall,
} from '@handstack/models';

export type GeminiErrorCode = 'TIMEOUT' | 'CANCELLED' | 'NETWORK' | 'HTTP' | 'INVALID_RESPONSE';
export class GeminiProviderError extends Error {
  constructor(
    readonly code: GeminiErrorCode,
    readonly status?: number,
  ) {
    super(`Gemini provider request failed: ${code}`);
    this.name = 'GeminiProviderError';
  }
}

export interface GeminiProviderOptions {
  readonly resolveApiKey: () => Promise<string | undefined>;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new GeminiProviderError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function baseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    throw new TypeError('Gemini base URL must use HTTPS');
  return url;
}
function usage(value: unknown): ProviderUsage {
  const item = object(value);
  if (typeof item.promptTokenCount !== 'number' || typeof item.candidatesTokenCount !== 'number')
    throw new GeminiProviderError('INVALID_RESPONSE');
  return { inputTokens: item.promptTokenCount, outputTokens: item.candidatesTokenCount };
}
function finish(value: unknown): ChatResponse['finishReason'] {
  if (value === 'STOP') return 'stop';
  if (value === 'MAX_TOKENS') return 'length';
  if (value === undefined || value === null) return 'tool_call';
  return 'error';
}
function parts(value: unknown): { content: string; toolCalls?: ToolCall[] } {
  if (!Array.isArray(value)) throw new GeminiProviderError('INVALID_RESPONSE');
  const text: string[] = [];
  const calls: ToolCall[] = [];
  for (const raw of value) {
    const part = object(raw);
    if (typeof part.text === 'string') text.push(part.text);
    if (part.functionCall !== undefined) {
      const call = object(part.functionCall);
      if (typeof call.name !== 'string') throw new GeminiProviderError('INVALID_RESPONSE');
      calls.push({
        id: typeof call.id === 'string' ? call.id : `gemini-${String(calls.length)}`,
        name: call.name,
        arguments: object(call.args),
      });
    }
  }
  return { content: text.join(''), ...(calls.length === 0 ? {} : { toolCalls: calls }) };
}
function requestBody(request: ChatRequest) {
  const system = request.messages
    .filter(({ role }) => role === 'system')
    .map(({ content }) => ({ text: content }));
  return {
    contents: request.messages
      .filter(({ role }) => role !== 'system')
      .map(({ role, content }) => ({
        role: role === 'assistant' ? 'model' : 'user',
        parts: [{ text: content }],
      })),
    ...(system.length === 0 ? {} : { systemInstruction: { parts: system } }),
    ...(request.tools === undefined
      ? {}
      : {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                parameters: tool.inputSchema,
              })),
            },
          ],
        }),
  };
}
function candidate(value: unknown) {
  const root = object(value);
  if (!Array.isArray(root.candidates) || root.candidates.length === 0)
    throw new GeminiProviderError('INVALID_RESPONSE');
  const item = object(root.candidates[0]);
  const content = object(item.content);
  return { root, item, result: parts(content.parts) };
}

export class GeminiProvider implements LLMProvider {
  private readonly root: URL;
  private readonly transport: typeof fetch;
  private readonly now: () => Date;
  constructor(private readonly options: GeminiProviderOptions) {
    this.root = baseUrl(options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta');
    this.transport = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }
  async health(): Promise<ProviderHealth> {
    try {
      await this.listModels();
      return { status: 'healthy', checkedAt: this.now() };
    } catch {
      return { status: 'unavailable', checkedAt: this.now() };
    }
  }
  async listModels(): Promise<readonly string[]> {
    const value = object(await this.json('/models', { method: 'GET' }));
    if (!Array.isArray(value.models)) throw new GeminiProviderError('INVALID_RESPONSE');
    return value.models
      .map((raw) => object(raw).name)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.replace(/^models\//, ''));
  }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const value = await this.json(
      `/models/${encodeURIComponent(request.model)}:generateContent`,
      { method: 'POST', body: JSON.stringify(requestBody(request)) },
      request.signal,
    );
    const { root, item, result } = candidate(value);
    return {
      ...result,
      finishReason: result.toolCalls === undefined ? finish(item.finishReason) : 'tool_call',
      usage: usage(root.usageMetadata),
    };
  }
  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    const response = await this.raw(
      `/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
      { method: 'POST', body: JSON.stringify(requestBody(request)) },
      request.signal,
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new GeminiProviderError('INVALID_RESPONSE');
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    for (;;) {
      const chunk = await this.bounded(reader.read(), request.signal);
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line.slice(5).trim()) as unknown;
        } catch {
          throw new GeminiProviderError('INVALID_RESPONSE');
        }
        const { root, item, result } = candidate(parsed);
        if (result.content !== '') yield { type: 'content', delta: result.content };
        for (const toolCall of result.toolCalls ?? []) yield { type: 'tool_call', toolCall };
        if (root.usageMetadata !== undefined)
          yield { type: 'usage', usage: usage(root.usageMetadata) };
        if (item.finishReason !== undefined) {
          done = true;
          yield {
            type: 'done',
            finishReason: result.toolCalls === undefined ? finish(item.finishReason) : 'tool_call',
          };
        }
      }
      if (chunk.done) break;
    }
    if (!done) throw new GeminiProviderError('INVALID_RESPONSE');
  }
  private async json(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const response = await this.raw(path, init, signal);
    try {
      return await this.bounded(response.json(), signal);
    } catch (error) {
      if (error instanceof GeminiProviderError) throw error;
      throw new GeminiProviderError('INVALID_RESPONSE');
    }
  }
  private async raw(path: string, init: RequestInit, external?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const cancel = () => {
      controller.abort();
    };
    external?.addEventListener('abort', cancel, { once: true });
    if (external?.aborted === true) controller.abort();
    const timer = setTimeout(cancel, this.options.timeoutMs ?? 30_000);
    try {
      const key = await this.options.resolveApiKey();
      if (key === undefined || key === '') throw new GeminiProviderError('NETWORK');
      const response = await this.transport(
        new URL(path.replace(/^\//, ''), `${this.root.href.replace(/\/$/, '')}/`),
        {
          ...init,
          signal: controller.signal,
          redirect: 'error',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-goog-api-key': key,
          },
        },
      );
      if (!response.ok) throw new GeminiProviderError('HTTP', response.status);
      return response;
    } catch (error) {
      if (error instanceof GeminiProviderError) throw error;
      if (external?.aborted === true) throw new GeminiProviderError('CANCELLED');
      if (controller.signal.aborted) throw new GeminiProviderError('TIMEOUT');
      throw new GeminiProviderError('NETWORK');
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', cancel);
    }
  }
  private bounded<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        reject(new GeminiProviderError('CANCELLED'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => {
        reject(new GeminiProviderError('TIMEOUT'));
      }, this.options.timeoutMs ?? 30_000);
      operation
        .then(resolve, () => {
          reject(new GeminiProviderError('INVALID_RESPONSE'));
        })
        .finally(() => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
        })
        .catch(() => undefined);
    });
  }
}
export function createGeminiProvider(options: GeminiProviderOptions): GeminiProvider {
  return new GeminiProvider(options);
}
