import type {
  ChatEvent,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ProviderHealth,
  ProviderUsage,
  ToolCall,
} from '@handstack/models';

export type AnthropicErrorCode = 'TIMEOUT' | 'CANCELLED' | 'NETWORK' | 'HTTP' | 'INVALID_RESPONSE';

export class AnthropicProviderError extends Error {
  constructor(
    readonly code: AnthropicErrorCode,
    readonly status?: number,
  ) {
    super(`Anthropic provider request failed: ${code}`);
    this.name = 'AnthropicProviderError';
  }
}

export interface AnthropicProviderOptions {
  readonly resolveApiKey: () => Promise<string | undefined>;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly apiVersion?: string;
  readonly maxTokens?: number;
  readonly now?: () => Date;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new AnthropicProviderError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

function baseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    throw new TypeError('Anthropic base URL must use HTTPS');
  return url;
}

function usage(value: unknown): ProviderUsage {
  const item = object(value);
  if (typeof item.input_tokens !== 'number' || typeof item.output_tokens !== 'number')
    throw new AnthropicProviderError('INVALID_RESPONSE');
  return { inputTokens: item.input_tokens, outputTokens: item.output_tokens };
}

function finish(value: unknown): ChatResponse['finishReason'] {
  if (value === 'end_turn' || value === 'stop_sequence') return 'stop';
  if (value === 'max_tokens') return 'length';
  if (value === 'tool_use') return 'tool_call';
  return 'error';
}

function blocks(value: unknown): { content: string; toolCalls?: ToolCall[] } {
  if (!Array.isArray(value)) throw new AnthropicProviderError('INVALID_RESPONSE');
  const text: string[] = [];
  const calls: ToolCall[] = [];
  for (const raw of value) {
    const block = object(raw);
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || typeof block.name !== 'string')
        throw new AnthropicProviderError('INVALID_RESPONSE');
      calls.push({ id: block.id, name: block.name, arguments: object(block.input) });
    }
  }
  return { content: text.join(''), ...(calls.length === 0 ? {} : { toolCalls: calls }) };
}

function requestBody(request: ChatRequest, stream: boolean, maxTokens: number) {
  const system = request.messages
    .filter(({ role }) => role === 'system')
    .map(({ content }) => content)
    .join('\n');
  return {
    model: request.model,
    max_tokens: maxTokens,
    stream,
    messages: request.messages
      .filter(({ role }) => role !== 'system')
      .map(({ role, content }) => ({ role: role === 'assistant' ? 'assistant' : 'user', content })),
    ...(system === '' ? {} : { system }),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            input_schema: tool.inputSchema,
          })),
        }),
  };
}

export class AnthropicProvider implements LLMProvider {
  private readonly root: URL;
  private readonly transport: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.root = baseUrl(options.baseUrl ?? 'https://api.anthropic.com/v1');
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
    if (!Array.isArray(value.data)) throw new AnthropicProviderError('INVALID_RESPONSE');
    return value.data
      .map((item) => object(item).id)
      .filter((id): id is string => typeof id === 'string');
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const value = object(
      await this.json(
        '/messages',
        {
          method: 'POST',
          body: JSON.stringify(requestBody(request, false, this.options.maxTokens ?? 4096)),
        },
        request.signal,
      ),
    );
    const result = blocks(value.content);
    return { ...result, finishReason: finish(value.stop_reason), usage: usage(value.usage) };
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    const response = await this.raw(
      '/messages',
      {
        method: 'POST',
        body: JSON.stringify(requestBody(request, true, this.options.maxTokens ?? 4096)),
      },
      request.signal,
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new AnthropicProviderError('INVALID_RESPONSE');
    let buffer = '';
    let stopped = false;
    let inputTokens = 0;
    let outputTokens = 0;
    const pendingTools = new Map<
      number,
      {
        readonly id: string;
        readonly name: string;
        readonly initial: Record<string, unknown>;
        json: string;
      }
    >();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await this.bounded(reader.read(), request.signal);
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const frame of events) {
        const line = frame.split(/\r?\n/).find((item) => item.startsWith('data:'));
        if (line === undefined) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line.slice(5).trim()) as unknown;
        } catch {
          throw new AnthropicProviderError('INVALID_RESPONSE');
        }
        const event = object(parsed);
        if (event.type === 'message_start') {
          const message = object(event.message);
          inputTokens = usage({
            ...object(message.usage),
            output_tokens: object(message.usage).output_tokens ?? 0,
          }).inputTokens;
        } else if (event.type === 'content_block_delta') {
          const delta = object(event.delta);
          if (delta.type === 'text_delta' && typeof delta.text === 'string')
            yield { type: 'content', delta: delta.text };
          if (
            delta.type === 'input_json_delta' &&
            typeof delta.partial_json === 'string' &&
            typeof event.index === 'number'
          ) {
            const pending = pendingTools.get(event.index);
            if (pending !== undefined) pending.json += delta.partial_json;
          }
        } else if (event.type === 'content_block_start') {
          const block = object(event.content_block);
          if (
            block.type === 'tool_use' &&
            typeof block.id === 'string' &&
            typeof block.name === 'string' &&
            typeof event.index === 'number'
          )
            pendingTools.set(event.index, {
              id: block.id,
              name: block.name,
              initial: object(block.input),
              json: '',
            });
        } else if (event.type === 'content_block_stop' && typeof event.index === 'number') {
          const pending = pendingTools.get(event.index);
          if (pending !== undefined) {
            let argumentsValue: Record<string, unknown> = pending.initial;
            if (pending.json !== '') {
              try {
                argumentsValue = object(JSON.parse(pending.json) as unknown);
              } catch {
                throw new AnthropicProviderError('INVALID_RESPONSE');
              }
            }
            yield {
              type: 'tool_call',
              toolCall: { id: pending.id, name: pending.name, arguments: argumentsValue },
            };
            pendingTools.delete(event.index);
          }
        } else if (event.type === 'message_delta') {
          const delta = object(event.delta);
          const eventUsage = object(event.usage);
          if (typeof eventUsage.output_tokens === 'number') outputTokens = eventUsage.output_tokens;
          yield { type: 'usage', usage: { inputTokens, outputTokens } };
          if (delta.stop_reason !== null && delta.stop_reason !== undefined)
            yield { type: 'done', finishReason: finish(delta.stop_reason) };
        } else if (event.type === 'message_stop') stopped = true;
      }
      if (chunk.done) break;
    }
    if (!stopped || pendingTools.size !== 0) throw new AnthropicProviderError('INVALID_RESPONSE');
  }

  private async json(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const response = await this.raw(path, init, signal);
    try {
      return await this.bounded(response.json(), signal);
    } catch (error) {
      if (error instanceof AnthropicProviderError) throw error;
      throw new AnthropicProviderError('INVALID_RESPONSE');
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
      if (key === undefined || key === '') throw new AnthropicProviderError('NETWORK');
      const response = await this.transport(
        new URL(path.replace(/^\//, ''), `${this.root.href.replace(/\/$/, '')}/`),
        {
          ...init,
          signal: controller.signal,
          redirect: 'error',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': this.options.apiVersion ?? '2023-06-01',
          },
        },
      );
      if (!response.ok) throw new AnthropicProviderError('HTTP', response.status);
      return response;
    } catch (error) {
      if (error instanceof AnthropicProviderError) throw error;
      if (external?.aborted === true) throw new AnthropicProviderError('CANCELLED');
      if (controller.signal.aborted) throw new AnthropicProviderError('TIMEOUT');
      throw new AnthropicProviderError('NETWORK');
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', cancel);
    }
  }

  private bounded<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        reject(new AnthropicProviderError('CANCELLED'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => {
        reject(new AnthropicProviderError('TIMEOUT'));
      }, this.options.timeoutMs ?? 30_000);
      operation
        .then(resolve, () => {
          reject(new AnthropicProviderError('INVALID_RESPONSE'));
        })
        .finally(() => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
        })
        .catch(() => undefined);
    });
  }
}

export function createAnthropicProvider(options: AnthropicProviderOptions): AnthropicProvider {
  return new AnthropicProvider(options);
}
