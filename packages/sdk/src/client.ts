import { HandStackApiError, HandStackSdkError, isProblemDetails } from './errors.js';
import { parseSse } from './sse.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HandStackClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Injectable HTTP transport; defaults to the global fetch implementation. */
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
}

export interface HandStackRequestOptions {
  readonly path: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

// --- Public data contracts ----------------------------------------------------

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
}

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream?: boolean;
  readonly temperature?: number;
}

export interface ChatCompletionChoice {
  readonly index: number;
  readonly message: { readonly role: string; readonly content: string };
  readonly finish_reason: string | null;
}

export interface ChatCompletion {
  readonly id: string;
  readonly object: string;
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ChatCompletionChoice[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

export interface ChatCompletionChunk {
  readonly id: string;
  readonly object: string;
  readonly choices: readonly {
    readonly index: number;
    readonly delta: { readonly content?: string };
    readonly finish_reason: string | null;
  }[];
}

export interface ModelEntry {
  readonly id: string;
  readonly object: string;
  readonly created: number;
  readonly owned_by: string;
}

export interface ModelsListResponse {
  readonly object: string;
  readonly data: readonly ModelEntry[];
}

export interface EmbeddingRequest {
  readonly model: string;
  readonly input: string | readonly string[];
}

export interface EmbeddingResponse {
  readonly object: string;
  readonly data: readonly {
    readonly object: string;
    readonly embedding: readonly number[];
    readonly index: number;
  }[];
  readonly model: string;
  readonly usage?: { readonly prompt_tokens: number; readonly total_tokens: number };
}

export interface NeutralChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface NeutralTool {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
  readonly description?: string;
}

export interface ModelResponseRequest {
  readonly model: string;
  readonly dataClassification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  readonly messages: readonly NeutralChatMessage[];
  readonly tools?: readonly NeutralTool[];
}

export interface ModelResponse {
  readonly content: string;
  readonly finishReason: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface ListResponse<T> {
  readonly items: readonly T[];
}

// --- Client -------------------------------------------------------------------

/** Typed client for the HandStack REST API and OpenAI-compatible gateway. */
export class HandStack {
  readonly openai: OpenAiNamespace;
  readonly capabilities: CapabilitiesNamespace;
  readonly models: ModelsNamespace;
  readonly agents: AgentsNamespace;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number | undefined;
  private readonly defaultHeaders: Readonly<Record<string, string>>;

  constructor(options: HandStackClientOptions) {
    if (options.baseUrl.trim() === '') throw new TypeError('HandStack baseUrl is required');
    if (options.apiKey.trim() === '') throw new TypeError('HandStack apiKey is required');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.openai = new OpenAiNamespace(this);
    this.capabilities = new CapabilitiesNamespace(this);
    this.models = new ModelsNamespace(this);
    this.agents = new AgentsNamespace(this);
  }

  /** Performs an authenticated JSON request and parses a typed response body. */
  async request<T>(options: HandStackRequestOptions): Promise<T> {
    const response = await this.send(options);
    await this.assertOk(response);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text === '') return undefined as T;
    return JSON.parse(text) as T;
  }

  /** Streams an authenticated SSE response as a sequence of parsed data events. */
  async *stream<T>(options: HandStackRequestOptions): AsyncIterable<T> {
    const response = await this.send(options);
    await this.assertOk(response);
    if (response.body === null) throw new HandStackSdkError('Response body is unavailable');
    for await (const event of parseSse(response.body)) {
      if (event.data === '[DONE]') break;
      if (event.data.trim() === '') continue;
      yield JSON.parse(event.data) as T;
    }
  }

  private async send(options: HandStackRequestOptions): Promise<Response> {
    const path = options.path.startsWith('/') ? options.path : `/${options.path}`;
    const headers = new Headers(this.defaultHeaders);
    headers.set('authorization', `Bearer ${this.apiKey}`);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);

    const signal = this.resolveSignal(options);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HandStackSdkError('HandStack request timed out or was aborted', { cause: error });
      }
      throw new HandStackSdkError('HandStack request failed', { cause: error });
    }
  }

  private async assertOk(response: Response): Promise<void> {
    if (response.ok) return;
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
    if (isProblemDetails(parsed)) throw new HandStackApiError(parsed);
    throw new HandStackApiError({
      type: 'about:blank',
      title: response.statusText === '' ? 'HTTP error' : response.statusText,
      status: response.status,
      detail: text.slice(0, 1000),
    });
  }

  private resolveSignal(options: HandStackRequestOptions): AbortSignal | undefined {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const signals: AbortSignal[] = [];
    if (options.signal !== undefined) signals.push(options.signal);
    if (timeoutMs !== undefined && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
    if (signals.length === 0) return undefined;
    if (signals.length === 1) return signals[0];
    return AbortSignal.any(signals);
  }
}

// --- Namespaces ----------------------------------------------------------------

export class OpenAiNamespace {
  readonly chat: OpenAiChatNamespace;
  readonly models: OpenAiModelsNamespace;
  readonly embeddings: OpenAiEmbeddingsNamespace;

  constructor(private readonly client: HandStack) {
    this.chat = new OpenAiChatNamespace(client);
    this.models = new OpenAiModelsNamespace(client);
    this.embeddings = new OpenAiEmbeddingsNamespace(client);
  }
}

export class OpenAiChatNamespace {
  readonly completions: OpenAiCompletionsNamespace;
  constructor(private readonly client: HandStack) {
    this.completions = new OpenAiCompletionsNamespace(client);
  }
}

export class OpenAiCompletionsNamespace {
  constructor(private readonly client: HandStack) {}

  create(body: ChatCompletionRequest): Promise<ChatCompletion> {
    return this.client.request<ChatCompletion>({
      method: 'POST',
      path: '/v1/chat/completions',
      body,
    });
  }

  stream(body: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk> {
    return this.client.stream<ChatCompletionChunk>({
      method: 'POST',
      path: '/v1/chat/completions',
      body: { ...body, stream: true },
    });
  }
}

export class OpenAiModelsNamespace {
  constructor(private readonly client: HandStack) {}

  list(): Promise<ModelsListResponse> {
    return this.client.request<ModelsListResponse>({ path: '/v1/models' });
  }
}

export class OpenAiEmbeddingsNamespace {
  constructor(private readonly client: HandStack) {}

  create(body: EmbeddingRequest): Promise<EmbeddingResponse> {
    return this.client.request<EmbeddingResponse>({ method: 'POST', path: '/v1/embeddings', body });
  }
}

export class CapabilitiesNamespace {
  constructor(private readonly client: HandStack) {}

  list(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/capabilities`,
    });
  }

  run(organizationId: string, slug: string, input: unknown): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/capabilities/${encodeURIComponent(slug)}/run`,
      body: input,
    });
  }
}

export class ModelsNamespace {
  constructor(private readonly client: HandStack) {}

  list(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/models`,
    });
  }

  response(organizationId: string, body: ModelResponseRequest): Promise<ModelResponse> {
    return this.client.request<ModelResponse>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/model-responses`,
      body,
    });
  }
}

export interface CreateAgentInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
}

export interface CreateAgentVersionInput {
  readonly model: string;
  readonly systemPrompt: string;
  readonly tools?: readonly string[];
  readonly maxIterations?: number;
  readonly timeoutMs?: number;
  readonly budgetUsd?: number;
}

export class AgentsNamespace {
  constructor(private readonly client: HandStack) {}

  list(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/agents`,
    });
  }

  create(organizationId: string, body: CreateAgentInput): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/agents`,
      body,
    });
  }

  versions(
    organizationId: string,
    agentId: string,
  ): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/agents/${encodeURIComponent(agentId)}/versions`,
    });
  }

  createVersion(
    organizationId: string,
    agentId: string,
    body: CreateAgentVersionInput,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/agents/${encodeURIComponent(agentId)}/versions`,
      body,
    });
  }

  publish(
    organizationId: string,
    agentId: string,
    versionId: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/publish`,
    });
  }
}
