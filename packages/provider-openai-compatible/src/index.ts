import type {
  ChatEvent,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ProviderHealth,
  ProviderUsage,
  ToolCall,
} from '@handstack/models';

export interface OpenAICompatibleOptions {
  readonly baseUrl: string;
  readonly resolveApiKey?: () => Promise<string | undefined>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly allowInsecureLocalhost?: boolean;
  readonly now?: () => Date;
  readonly models?: readonly string[];
  readonly modelsPath?: string;
  readonly chatCompletionsPath?: string;
  readonly apiKeyHeader?: string;
  readonly apiKeyPrefix?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
}

export class ProviderRequestError extends Error {
  constructor(
    readonly code: 'TIMEOUT' | 'CANCELLED' | 'NETWORK' | 'HTTP' | 'INVALID_RESPONSE',
    readonly status?: number,
  ) {
    super(`Provider request failed: ${code}`);
    this.name = 'ProviderRequestError';
  }
}

function validBaseUrl(value: string, allowLocal: boolean): URL {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username !== '' ||
    url.password !== '' ||
    (url.protocol !== 'https:' && !(allowLocal && local && url.protocol === 'http:'))
  ) {
    throw new TypeError('Provider base URL must use HTTPS');
  }
  return url;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ProviderRequestError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

function usage(value: unknown): ProviderUsage {
  const item = record(value);
  const inputTokens = item.prompt_tokens;
  const outputTokens = item.completion_tokens;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number')
    throw new ProviderRequestError('INVALID_RESPONSE');
  return { inputTokens, outputTokens };
}

function finishReason(value: unknown): ChatResponse['finishReason'] {
  if (value === 'stop' || value === 'length') return value;
  if (value === 'tool_calls' || value === 'function_call') return 'tool_call';
  return 'error';
}

function toolCalls(value: unknown): ToolCall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ProviderRequestError('INVALID_RESPONSE');
  return value.map((raw) => {
    const item = record(raw);
    const fn = record(item.function);
    if (
      typeof item.id !== 'string' ||
      typeof fn.name !== 'string' ||
      typeof fn.arguments !== 'string'
    )
      throw new ProviderRequestError('INVALID_RESPONSE');
    let args: unknown;
    try {
      args = JSON.parse(fn.arguments) as unknown;
    } catch {
      throw new ProviderRequestError('INVALID_RESPONSE');
    }
    return { id: item.id, name: fn.name, arguments: record(args) };
  });
}

function requestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              parameters: tool.inputSchema,
            },
          })),
        }),
  };
}

export class OpenAICompatibleProvider implements LLMProvider {
  private readonly baseUrl: URL;
  private readonly transport: typeof fetch;
  private readonly now: () => Date;
  constructor(private readonly options: OpenAICompatibleOptions) {
    this.baseUrl = validBaseUrl(options.baseUrl, options.allowInsecureLocalhost ?? false);
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
    if (this.options.models !== undefined) return [...this.options.models];
    const value = record(await this.json(this.options.modelsPath ?? '/models', { method: 'GET' }));
    if (!Array.isArray(value.data)) throw new ProviderRequestError('INVALID_RESPONSE');
    return value.data
      .map((item) => record(item).id)
      .filter((id): id is string => typeof id === 'string');
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const value = record(
      await this.json(
        this.options.chatCompletionsPath ?? '/chat/completions',
        { method: 'POST', body: JSON.stringify(requestBody(request, false)) },
        request.signal,
      ),
    );
    if (!Array.isArray(value.choices) || value.choices.length === 0)
      throw new ProviderRequestError('INVALID_RESPONSE');
    const choice = record(value.choices[0]);
    const message = record(choice.message);
    if (typeof message.content !== 'string' && message.content !== null)
      throw new ProviderRequestError('INVALID_RESPONSE');
    const calls = toolCalls(message.tool_calls);
    return {
      content: typeof message.content === 'string' ? message.content : '',
      finishReason: finishReason(choice.finish_reason),
      usage: usage(value.usage),
      ...(calls === undefined ? {} : { toolCalls: calls }),
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    const response = await this.raw(
      this.options.chatCompletionsPath ?? '/chat/completions',
      { method: 'POST', body: JSON.stringify(requestBody(request, true)) },
      request.signal,
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new ProviderRequestError('INVALID_RESPONSE');
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
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          done = true;
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch {
          throw new ProviderRequestError('INVALID_RESPONSE');
        }
        const value = record(parsed);
        if (value.usage !== undefined) yield { type: 'usage', usage: usage(value.usage) };
        if (!Array.isArray(value.choices)) continue;
        for (const rawChoice of value.choices) {
          const choice = record(rawChoice);
          const delta = record(choice.delta);
          if (typeof delta.content === 'string') yield { type: 'content', delta: delta.content };
          const calls = toolCalls(delta.tool_calls);
          for (const call of calls ?? []) yield { type: 'tool_call', toolCall: call };
          if (choice.finish_reason !== null && choice.finish_reason !== undefined)
            yield { type: 'done', finishReason: finishReason(choice.finish_reason) };
        }
      }
      if (chunk.done) break;
    }
    if (!done) throw new ProviderRequestError('INVALID_RESPONSE');
  }

  private async json(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const response = await this.raw(path, init, signal);
    try {
      return await this.bounded(response.json(), signal);
    } catch {
      throw new ProviderRequestError('INVALID_RESPONSE');
    }
  }

  private async raw(
    path: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted === true) controller.abort();
    const timer = setTimeout(abort, this.options.timeoutMs ?? 30_000);
    try {
      const key = await this.options.resolveApiKey?.();
      const response = await this.transport(
        new URL(path.replace(/^\//, ''), `${this.baseUrl.href.replace(/\/$/, '')}/`),
        {
          ...init,
          signal: controller.signal,
          redirect: 'error',
          headers: {
            ...this.options.defaultHeaders,
            accept: 'application/json',
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(key === undefined
              ? {}
              : {
                  [this.options.apiKeyHeader ?? 'authorization']:
                    `${this.options.apiKeyPrefix ?? 'Bearer '}${key}`,
                }),
          },
        },
      );
      if (!response.ok) throw new ProviderRequestError('HTTP', response.status);
      return response;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (externalSignal?.aborted === true) throw new ProviderRequestError('CANCELLED');
      if (controller.signal.aborted) throw new ProviderRequestError('TIMEOUT');
      throw new ProviderRequestError('NETWORK');
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  private bounded<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        reject(new ProviderRequestError('CANCELLED'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => {
        reject(new ProviderRequestError('TIMEOUT'));
      }, this.options.timeoutMs ?? 30_000);
      operation
        .then(resolve, () => {
          reject(new ProviderRequestError('INVALID_RESPONSE'));
        })
        .finally(() => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
        })
        .catch(() => undefined);
    });
  }
}

export function createOpenAIProvider(
  options: Omit<OpenAICompatibleOptions, 'baseUrl' | 'allowInsecureLocalhost'> & {
    readonly baseUrl?: string;
  },
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    ...options,
    baseUrl: options.baseUrl ?? 'https://api.openai.com/v1',
  });
}

export function createOllamaProvider(
  options: Omit<OpenAICompatibleOptions, 'baseUrl' | 'allowInsecureLocalhost' | 'resolveApiKey'> & {
    readonly baseUrl?: string;
  } = {},
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    ...options,
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:11434/v1',
    allowInsecureLocalhost: true,
  });
}

export interface AzureOpenAIProviderOptions extends Omit<
  OpenAICompatibleOptions,
  | 'baseUrl'
  | 'allowInsecureLocalhost'
  | 'models'
  | 'modelsPath'
  | 'chatCompletionsPath'
  | 'apiKeyHeader'
  | 'apiKeyPrefix'
  | 'defaultHeaders'
> {
  readonly resourceName: string;
  readonly deployment: string;
  readonly apiVersion: string;
}

export function createAzureOpenAIProvider(
  options: AzureOpenAIProviderOptions,
): OpenAICompatibleProvider {
  if (!/^[a-zA-Z0-9-]+$/.test(options.resourceName))
    throw new TypeError('Invalid Azure OpenAI resource name');
  if (options.deployment === '' || options.apiVersion === '')
    throw new TypeError('Azure OpenAI deployment and API version are required');
  const { resourceName, deployment, apiVersion, ...shared } = options;
  return new OpenAICompatibleProvider({
    ...shared,
    baseUrl: `https://${resourceName}.openai.azure.com/openai/deployments/${encodeURIComponent(deployment)}`,
    models: [deployment],
    chatCompletionsPath: `/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
    apiKeyHeader: 'api-key',
    apiKeyPrefix: '',
  });
}

export interface OpenRouterProviderOptions extends Omit<
  OpenAICompatibleOptions,
  'baseUrl' | 'allowInsecureLocalhost' | 'defaultHeaders'
> {
  readonly baseUrl?: string;
  readonly applicationUrl?: string;
  readonly applicationName?: string;
}

export function createOpenRouterProvider(
  options: OpenRouterProviderOptions,
): OpenAICompatibleProvider {
  const { applicationUrl, applicationName, ...shared } = options;
  return new OpenAICompatibleProvider({
    ...shared,
    baseUrl: options.baseUrl ?? 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      ...(applicationUrl === undefined ? {} : { 'HTTP-Referer': applicationUrl }),
      ...(applicationName === undefined ? {} : { 'X-Title': applicationName }),
    },
  });
}

export function createVllmProvider(
  options: Omit<OpenAICompatibleOptions, 'allowInsecureLocalhost'> & { readonly baseUrl: string },
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({ ...options, allowInsecureLocalhost: true });
}
