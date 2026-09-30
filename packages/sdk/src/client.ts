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
  /** Raw body for multipart or other browser-managed content types. */
  readonly rawBody?: BodyInit;
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

export interface ChatWorkspaceExecutionRequest {
  readonly model: string;
  readonly dataClassification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  readonly agentId?: string;
  readonly knowledgeBaseId?: string;
  readonly parentMessageId?: string;
  readonly traceId?: string;
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
  readonly knowledge: KnowledgeNamespace;
  readonly privacy: PrivacyNamespace;
  readonly mcp: McpNamespace;
  readonly plugins: PluginsNamespace;
  readonly secrets: SecretsNamespace;
  readonly workflows: WorkflowsNamespace;
  readonly notifications: NotificationsNamespace;
  readonly incidents: IncidentsNamespace;
  readonly operations: OperationsNamespace;
  readonly settings: SettingsNamespace;
  readonly gateway: GatewayNamespace;
  readonly webhooks: WebhooksNamespace;
  readonly chat: ChatWorkspaceNamespace;
  readonly access: AccessNamespace;
  readonly directory: DirectoryNamespace;
  readonly identity: IdentityNamespace;
  readonly scim: ScimNamespace;
  readonly budgets: BudgetsNamespace;
  readonly policies: PoliciesNamespace;
  readonly serviceAccounts: ServiceAccountsNamespace;
  readonly routing: RoutingNamespace;

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
    this.knowledge = new KnowledgeNamespace(this);
    this.privacy = new PrivacyNamespace(this);
    this.mcp = new McpNamespace(this);
    this.plugins = new PluginsNamespace(this);
    this.secrets = new SecretsNamespace(this);
    this.workflows = new WorkflowsNamespace(this);
    this.notifications = new NotificationsNamespace(this);
    this.incidents = new IncidentsNamespace(this);
    this.operations = new OperationsNamespace(this);
    this.settings = new SettingsNamespace(this);
    this.gateway = new GatewayNamespace(this);
    this.webhooks = new WebhooksNamespace(this);
    this.chat = new ChatWorkspaceNamespace(this);
    this.access = new AccessNamespace(this);
    this.directory = new DirectoryNamespace(this);
    this.identity = new IdentityNamespace(this);
    this.scim = new ScimNamespace(this);
    this.budgets = new BudgetsNamespace(this);
    this.policies = new PoliciesNamespace(this);
    this.serviceAccounts = new ServiceAccountsNamespace(this);
    this.routing = new RoutingNamespace(this);
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
    if (options.body !== undefined && options.rawBody !== undefined)
      throw new TypeError('Request body and rawBody are mutually exclusive');
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);

    const signal = this.resolveSignal(options);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...(options.rawBody !== undefined
          ? { body: options.rawBody }
          : options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
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

  providers(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/providers`,
    });
  }

  createProvider(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/providers`,
      body,
    });
  }

  createModel(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/models`,
      body,
    });
  }

  prompts(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.listResource(organizationId, 'prompts');
  }

  createPrompt(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.create(organizationId, 'prompts', body);
  }

  promptVersions(
    organizationId: string,
    promptId: string,
  ): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/prompts/${encodeURIComponent(promptId)}/versions`,
    });
  }

  createPromptVersion(
    organizationId: string,
    promptId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/prompts/${encodeURIComponent(promptId)}/versions`,
      body,
    });
  }

  evaluationDatasets(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.listResource(organizationId, 'evaluation-datasets');
  }

  createEvaluationDataset(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.create(organizationId, 'evaluation-datasets', body);
  }

  evaluationSuites(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.listResource(organizationId, 'evaluation-suites');
  }

  createEvaluationSuite(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.create(organizationId, 'evaluation-suites', body);
  }

  redTeamCampaigns(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.listResource(organizationId, 'red-team-campaigns');
  }

  createRedTeamCampaign(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.create(organizationId, 'red-team-campaigns', body);
  }

  executeRedTeamCampaign(
    organizationId: string,
    campaignId: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/red-team-campaigns/${encodeURIComponent(campaignId)}/execute`,
    });
  }

  evaluationRun(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.create(organizationId, 'evaluation-runs', body);
  }

  recordEvaluationGate(
    organizationId: string,
    modelId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.action(
      organizationId,
      `models/${encodeURIComponent(modelId)}/evaluation-gates`,
      body,
    );
  }

  approveModel(organizationId: string, modelId: string): Promise<Record<string, unknown>> {
    return this.action(organizationId, `models/${encodeURIComponent(modelId)}/approve`);
  }

  publishModel(organizationId: string, modelId: string): Promise<Record<string, unknown>> {
    return this.action(organizationId, `models/${encodeURIComponent(modelId)}/publish`);
  }

  overrideModelApproval(
    organizationId: string,
    modelId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.action(
      organizationId,
      `models/${encodeURIComponent(modelId)}/approval-override`,
      body,
    );
  }

  recordPromptEvaluationGate(
    organizationId: string,
    promptVersionId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.action(
      organizationId,
      `prompt-versions/${encodeURIComponent(promptVersionId)}/evaluation-gates`,
      body,
    );
  }

  approvePromptVersion(
    organizationId: string,
    promptVersionId: string,
  ): Promise<Record<string, unknown>> {
    return this.action(
      organizationId,
      `prompt-versions/${encodeURIComponent(promptVersionId)}/approve`,
    );
  }

  publishPromptVersion(
    organizationId: string,
    promptVersionId: string,
  ): Promise<Record<string, unknown>> {
    return this.action(
      organizationId,
      `prompt-versions/${encodeURIComponent(promptVersionId)}/publish`,
    );
  }

  overridePromptApproval(
    organizationId: string,
    promptVersionId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.action(
      organizationId,
      `prompt-versions/${encodeURIComponent(promptVersionId)}/approval-override`,
      body,
    );
  }

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

  private listResource(
    organizationId: string,
    resource: string,
  ): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/${resource}`,
    });
  }

  private create(
    organizationId: string,
    resource: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/${resource}`,
      body,
    });
  }

  private action(
    organizationId: string,
    resource: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/${resource}`,
      ...(body === undefined ? {} : { body }),
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

export type AgentRunRequest =
  | { readonly prompt: string; readonly repository?: string }
  | { readonly repository: string; readonly prompt?: string };

export interface AgentRunResponse {
  readonly runId: string;
  readonly content: string;
  readonly iterations: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
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

  run(agentId: string, body: AgentRunRequest): Promise<AgentRunResponse> {
    return this.client.request<AgentRunResponse>({
      method: 'POST',
      path: `/api/v1/agents/${encodeURIComponent(agentId)}/run`,
      body,
    });
  }

  stream(agentId: string, body: AgentRunRequest): AsyncIterable<Record<string, unknown>> {
    return this.client.stream<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/agents/${encodeURIComponent(agentId)}/stream`,
      body,
    });
  }
}

export class KnowledgeNamespace {
  constructor(private readonly client: HandStack) {}

  bases(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/bases`,
    });
  }

  documents(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/documents`,
    });
  }

  createBase(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/bases`,
      body,
    });
  }

  createDocument(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/documents`,
      body,
    });
  }

  ingest(organizationId: string, documentId: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/documents/${encodeURIComponent(documentId)}/ingest`,
    });
  }

  sync(organizationId: string, documentId: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/documents/${encodeURIComponent(documentId)}/sync`,
    });
  }

  versions(
    organizationId: string,
    documentId: string,
  ): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/documents/${encodeURIComponent(documentId)}/versions`,
    });
  }

  search(organizationId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/search`,
      body,
    });
  }

  reindex(organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/reindex-jobs`,
      body,
    });
  }

  reindexJob(organizationId: string, jobId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/reindex-jobs/${encodeURIComponent(jobId)}`,
    });
  }

  runReindexJob(organizationId: string, jobId: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/reindex-jobs/${encodeURIComponent(jobId)}/run`,
    });
  }

  cancelReindexJob(organizationId: string, jobId: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/reindex-jobs/${encodeURIComponent(jobId)}/cancel`,
    });
  }
}

export class PrivacyNamespace {
  constructor(private readonly client: HandStack) {}

  retention(organizationId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/retention`,
    });
  }

  runRetention(organizationId: string, body: Record<string, unknown> = {}): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/retention/run`,
      body,
    });
  }

  setRetention(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/retention`,
      body,
    });
  }

  runUsageRetention(organizationId: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/retention/usage/run`,
    });
  }

  runAttachmentRetention(organizationId: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/retention/attachments/run`,
    });
  }

  runTraceRetention(organizationId: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/retention/traces/run`,
    });
  }

  legalHolds(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/legal-holds`,
    });
  }

  createLegalHold(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/legal-holds`,
      body,
    });
  }

  releaseLegalHold(organizationId: string, holdId: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/legal-holds/${encodeURIComponent(holdId)}/release`,
    });
  }

  subjectRequests(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/subject-requests`,
    });
  }

  createSubjectRequest(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/subject-requests`,
      body,
    });
  }

  updateSubjectRequest(
    organizationId: string,
    requestId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/subject-requests/${encodeURIComponent(requestId)}`,
      body,
    });
  }

  executeSubjectRequest(
    organizationId: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/subject-requests/${encodeURIComponent(requestId)}/execute`,
    });
  }

  subjectRequestExport(
    organizationId: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/subject-requests/${encodeURIComponent(requestId)}/export`,
    });
  }

  inventory(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/inventory`,
    });
  }

  createInventory(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/inventory`,
      body,
    });
  }

  purposes(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/purposes`,
    });
  }

  createPurpose(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/purposes`,
      body,
    });
  }

  consents(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/consents`,
    });
  }

  createConsent(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/consents`,
      body,
    });
  }

  withdrawConsent(organizationId: string, consentId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/consents/${encodeURIComponent(consentId)}/withdraw`,
    });
  }

  processors(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/processors`,
    });
  }

  createProcessor(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/processors`,
      body,
    });
  }

  incidents(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/incidents`,
    });
  }

  createIncident(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/incidents`,
      body,
    });
  }

  deletionJobs(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/deletion-jobs`,
    });
  }

  deletionEvidence(
    organizationId: string,
    jobId: string,
  ): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/deletion-jobs/${encodeURIComponent(jobId)}/evidence`,
    });
  }

  residency(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/residency`,
    });
  }

  setResidency(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/privacy/residency`,
      body,
    });
  }
}

export class McpNamespace {
  constructor(private readonly client: HandStack) {}

  servers(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/mcp/servers/${encodeURIComponent(organizationId)}`,
    });
  }

  registerServer(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/mcp/servers/${encodeURIComponent(organizationId)}`,
      body,
    });
  }

  discover(organizationId: string, serverId: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/mcp/servers/${encodeURIComponent(organizationId)}/${encodeURIComponent(serverId)}/discover`,
    });
  }

  reconnect(organizationId: string, serverId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/mcp/servers/${encodeURIComponent(organizationId)}/${encodeURIComponent(serverId)}/reconnect`,
    });
  }

  tools(organizationId: string, serverId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/mcp/servers/${encodeURIComponent(organizationId)}/${encodeURIComponent(serverId)}/tools`,
    });
  }

  resources(
    organizationId: string,
    serverId: string,
  ): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/mcp/servers/${encodeURIComponent(organizationId)}/${encodeURIComponent(serverId)}/resources`,
    });
  }

  prompts(
    organizationId: string,
    serverId: string,
  ): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/mcp/servers/${encodeURIComponent(organizationId)}/${encodeURIComponent(serverId)}/prompts`,
    });
  }

  callTool(
    organizationId: string,
    serverId: string,
    toolName: string,
    argumentsValue: unknown,
  ): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/mcp/servers/${encodeURIComponent(organizationId)}/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}/call`,
      body: argumentsValue,
    });
  }

  saveCredential(
    organizationId: string,
    serverId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/mcp/servers/${encodeURIComponent(organizationId)}/${encodeURIComponent(serverId)}/credentials`,
      body,
    });
  }

  startOAuth(organizationId: string, serverId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/mcp/servers/${encodeURIComponent(organizationId)}/${encodeURIComponent(serverId)}/oauth/start`,
    });
  }

  completeOAuth(
    organizationId: string,
    serverId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/mcp/servers/${encodeURIComponent(organizationId)}/${encodeURIComponent(serverId)}/oauth/callback`,
      body,
    });
  }
}

export class PluginsNamespace {
  constructor(private readonly client: HandStack) {}

  list(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/plugins`,
    });
  }

  install(organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/plugins`,
      body,
    });
  }

  enable(organizationId: string, pluginName: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/plugins/${encodeURIComponent(pluginName)}/enable`,
    });
  }

  disable(organizationId: string, pluginName: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/plugins/${encodeURIComponent(pluginName)}/disable`,
    });
  }

  quarantine(
    organizationId: string,
    pluginName: string,
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/plugins/${encodeURIComponent(pluginName)}/quarantine`,
      body,
    });
  }

  upgrade(
    organizationId: string,
    pluginName: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/plugins/${encodeURIComponent(pluginName)}/upgrade`,
      body,
    });
  }

  uninstall(organizationId: string, pluginName: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'DELETE',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/plugins/${encodeURIComponent(pluginName)}`,
    });
  }
}

export class SecretsNamespace {
  constructor(private readonly client: HandStack) {}

  list(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/secrets`,
    });
  }

  create(organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/secrets`,
      body,
    });
  }

  rotate(
    organizationId: string,
    secretId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/secrets/${encodeURIComponent(secretId)}/rotate`,
      body,
    });
  }

  remove(organizationId: string, secretId: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'DELETE',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/secrets/${encodeURIComponent(secretId)}`,
    });
  }
}

export class WorkflowsNamespace {
  constructor(private readonly client: HandStack) {}

  list(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/workflows`,
    });
  }

  create(organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/workflows`,
      body,
    });
  }

  publish(organizationId: string, workflowId: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/workflows/${encodeURIComponent(workflowId)}/publish`,
    });
  }

  execute(
    organizationId: string,
    workflowId: string,
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/workflows/${encodeURIComponent(workflowId)}/executions`,
      body,
    });
  }

  emitEvent(
    organizationId: string,
    eventName: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/workflows/events/${encodeURIComponent(eventName)}`,
      body,
    });
  }

  tickSchedules(organizationId: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/workflows/schedules/tick`,
    });
  }

  execution(
    organizationId: string,
    workflowId: string,
    executionId: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/workflows/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}`,
    });
  }

  steps(
    organizationId: string,
    workflowId: string,
    executionId: string,
  ): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/workflows/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}/steps`,
    });
  }
}

export class NotificationsNamespace {
  constructor(private readonly client: HandStack) {}

  list(
    organizationId: string,
    recipientId: string,
  ): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/notifications/${encodeURIComponent(recipientId)}`,
    });
  }

  send(organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/notifications`,
      body,
    });
  }
}

export class IncidentsNamespace {
  constructor(private readonly client: HandStack) {}

  list(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/incidents`,
    });
  }

  get(organizationId: string, incidentId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/incidents/${encodeURIComponent(incidentId)}`,
    });
  }

  create(organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/incidents`,
      body,
    });
  }

  transition(
    organizationId: string,
    incidentId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/incidents/${encodeURIComponent(incidentId)}/status`,
      body,
    });
  }

  timeline(
    organizationId: string,
    incidentId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/incidents/${encodeURIComponent(incidentId)}/timeline`,
      body,
    });
  }

  updateAction(
    organizationId: string,
    incidentId: string,
    actionId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/incidents/${encodeURIComponent(incidentId)}/actions/${encodeURIComponent(actionId)}`,
      body,
    });
  }

  escalationPolicy(organizationId: string, capability: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/incidents/escalation-policies/${encodeURIComponent(capability)}`,
    });
  }

  setEscalationPolicy(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/incidents/escalation-policies`,
      body,
    });
  }
}

export class OperationsNamespace {
  constructor(private readonly client: HandStack) {}

  create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: '/api/v1/operations',
      body,
    });
  }

  get(operationId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: `/api/v1/operations/${encodeURIComponent(operationId)}`,
    });
  }

  cancel(operationId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/operations/${encodeURIComponent(operationId)}/cancel`,
    });
  }

  featureFlags(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/feature-flags`,
    });
  }

  setFeatureFlag(
    organizationId: string,
    key: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PUT',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/feature-flags/${encodeURIComponent(key)}`,
      body,
    });
  }

  audit(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/audit`,
    });
  }

  verifyAudit(organizationId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/audit/verify`,
    });
  }

  enqueueJob(
    organizationId: string,
    queue: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/jobs/${encodeURIComponent(queue)}`,
      body,
    });
  }

  deadLetters(
    organizationId: string,
    queue: string,
  ): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/jobs/${encodeURIComponent(queue)}/dead-letters`,
    });
  }

  retryDeadLetter(
    organizationId: string,
    queue: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/jobs/${encodeURIComponent(queue)}/dead-letters/${encodeURIComponent(idempotencyKey)}/retry`,
    });
  }

  discardDeadLetter(
    organizationId: string,
    queue: string,
    idempotencyKey: string,
  ): Promise<{ discarded: boolean }> {
    return this.client.request<{ discarded: boolean }>({
      method: 'DELETE',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/jobs/${encodeURIComponent(queue)}/dead-letters/${encodeURIComponent(idempotencyKey)}`,
    });
  }
}

export class SettingsNamespace {
  constructor(private readonly client: HandStack) {}

  get(organizationId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/settings`,
    });
  }

  update(organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/settings`,
      body,
    });
  }

  database(): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: '/api/v1/admin/settings/database',
    });
  }

  updateDatabase(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: '/api/v1/admin/settings/database',
      body,
    });
  }
}

export class GatewayNamespace {
  constructor(private readonly client: HandStack) {}

  keys(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/gateway/keys`,
    });
  }

  issue(organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/gateway/keys`,
      body,
    });
  }

  revoke(organizationId: string, keyId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/gateway/keys/${encodeURIComponent(keyId)}/revoke`,
    });
  }
}

export class WebhooksNamespace {
  constructor(private readonly client: HandStack) {}

  configure(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/webhooks/configuration`,
      body,
    });
  }

  dispatch(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/webhooks/deliveries`,
      body,
    });
  }

  rotateSecret(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/webhooks/configuration/rotate-secret`,
      body,
    });
  }

  deliveries(
    organizationId: string,
    status?: string,
  ): Promise<ListResponse<Record<string, unknown>>> {
    const query = status === undefined ? '' : `?status=${encodeURIComponent(status)}`;
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/webhooks/deliveries${query}`,
    });
  }

  deadLetters(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/webhooks/dead-letters`,
    });
  }

  replay(organizationId: string, deliveryId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/webhooks/dead-letters/${encodeURIComponent(deliveryId)}/replay`,
    });
  }
}

export class ChatWorkspaceNamespace {
  constructor(private readonly client: HandStack) {}

  models(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/chat/models`,
    });
  }

  agents(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/chat/agents`,
    });
  }

  conversations(
    organizationId: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: withQuery(
        `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations`,
        options,
      ),
    });
  }

  createConversation(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations`,
      body,
    });
  }

  archive(organizationId: string, conversationId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(conversationId)}/archive`,
    });
  }

  restore(organizationId: string, conversationId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(conversationId)}/restore`,
    });
  }

  remove(organizationId: string, conversationId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'DELETE',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(conversationId)}`,
    });
  }

  history(
    organizationId: string,
    conversationId: string,
    branchId: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: withQuery(
        `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(conversationId)}/branches/${encodeURIComponent(branchId)}/messages`,
        options,
      ),
    });
  }

  appendMessage(
    organizationId: string,
    conversationId: string,
    branchId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(conversationId)}/branches/${encodeURIComponent(branchId)}/messages`,
      body,
    });
  }

  uploadAttachment(
    organizationId: string,
    conversationId: string,
    file: Blob,
    filename?: string,
    dataClassification = 'INTERNAL',
  ): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append('file', file, filename);
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(conversationId)}/attachments?dataClassification=${encodeURIComponent(dataClassification)}`,
      rawBody: form,
    });
  }

  attachmentUrl(
    organizationId: string,
    conversationId: string,
    attachmentId: string,
    expiresInSeconds = 300,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}/url?expiresInSeconds=${String(expiresInSeconds)}`,
    });
  }

  deleteAttachment(
    organizationId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<undefined> {
    return this.client.request<undefined>({
      method: 'DELETE',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`,
    });
  }

  execute(
    organizationId: string,
    conversationId: string,
    branchId: string,
    idempotencyKey: string,
    body: ChatWorkspaceExecutionRequest,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(conversationId)}/branches/${encodeURIComponent(branchId)}/executions`,
      headers: { 'idempotency-key': idempotencyKey },
      body,
    });
  }

  edit(
    organizationId: string,
    conversationId: string,
    messageId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/edit`,
      body,
    });
  }

  regenerate(
    organizationId: string,
    conversationId: string,
    messageId: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.revise(
      'regenerate',
      organizationId,
      conversationId,
      messageId,
      idempotencyKey,
      body,
    );
  }

  retry(
    organizationId: string,
    conversationId: string,
    messageId: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.revise('retry', organizationId, conversationId, messageId, idempotencyKey, body);
  }

  cancel(organizationId: string, messageId: string, idempotencyKey: string): Promise<unknown> {
    return this.client.request<unknown>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/messages/${encodeURIComponent(messageId)}/cancel`,
      headers: { 'idempotency-key': idempotencyKey },
    });
  }

  events(
    organizationId: string,
    messageId: string,
    lastEventId?: string,
  ): AsyncIterable<Record<string, unknown>> {
    return this.client.stream<Record<string, unknown>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/messages/${encodeURIComponent(messageId)}/events`,
      ...(lastEventId === undefined ? {} : { headers: { 'last-event-id': lastEventId } }),
    });
  }

  private revise(
    action: 'regenerate' | 'retry',
    organizationId: string,
    conversationId: string,
    messageId: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/${action}`,
      headers: { 'idempotency-key': idempotencyKey },
      body,
    });
  }
}

export class AccessNamespace {
  constructor(private readonly client: HandStack) {}

  listRequests(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/access-requests`,
    });
  }

  submitRequest(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/access-requests`,
      body,
    });
  }

  grants(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/access-requests/grants`,
    });
  }

  approve(
    organizationId: string,
    requestId: string,
    approverId: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/access-requests/${encodeURIComponent(requestId)}/approve`,
      body: { approverId },
    });
  }

  revoke(
    organizationId: string,
    requestId: string,
    grantId: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/access-requests/${encodeURIComponent(requestId)}/grants/${encodeURIComponent(grantId)}/revoke`,
    });
  }
}

export class IdentityNamespace {
  constructor(private readonly client: HandStack) {}

  providers(organizationId: string): Promise<readonly Record<string, unknown>[]> {
    return this.list(organizationId, 'providers');
  }

  users(organizationId: string): Promise<readonly Record<string, unknown>[]> {
    return this.list(organizationId, 'users');
  }

  createUser(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.create(organizationId, 'users', body);
  }

  groups(organizationId: string): Promise<readonly Record<string, unknown>[]> {
    return this.list(organizationId, 'groups');
  }

  createGroup(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.create(organizationId, 'groups', body);
  }

  roles(organizationId: string): Promise<readonly Record<string, unknown>[]> {
    return this.list(organizationId, 'roles');
  }

  createRole(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.create(organizationId, 'roles', body);
  }

  createProvider(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.create(organizationId, 'providers', body);
  }

  setProviderEnabled(
    organizationId: string,
    providerId: string,
    body: { readonly enabled: boolean },
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: `${this.base(organizationId)}/providers/${encodeURIComponent(providerId)}/enabled`,
      body,
    });
  }

  mappings(
    organizationId: string,
    providerId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    return this.client.request<readonly Record<string, unknown>[]>({
      path: `${this.base(organizationId)}/providers/${encodeURIComponent(providerId)}/mappings`,
    });
  }

  testConnection(organizationId: string, providerId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `${this.base(organizationId)}/providers/${encodeURIComponent(providerId)}/test-connection`,
    });
  }

  setMappings(
    organizationId: string,
    providerId: string,
    body: readonly Record<string, unknown>[],
  ): Promise<readonly Record<string, unknown>[]> {
    return this.client.request<readonly Record<string, unknown>[]>({
      method: 'PATCH',
      path: `${this.base(organizationId)}/providers/${encodeURIComponent(providerId)}/mappings`,
      body,
    });
  }

  loginPolicy(organizationId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: `${this.base(organizationId)}/login-policy`,
    });
  }

  setLoginPolicy(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: `${this.base(organizationId)}/login-policy`,
      body,
    });
  }

  enableBreakGlass(
    organizationId: string,
    userId: string,
    body: { readonly password: string },
  ): Promise<{ enabled: true }> {
    return this.client.request<{ enabled: true }>({
      method: 'POST',
      path: `${this.base(organizationId)}/break-glass/${encodeURIComponent(userId)}`,
      body,
    });
  }

  disableBreakGlass(organizationId: string, userId: string): Promise<{ enabled: false }> {
    return this.client.request<{ enabled: false }>({
      method: 'PATCH',
      path: `${this.base(organizationId)}/break-glass/${encodeURIComponent(userId)}/disable`,
    });
  }

  deprovisionUser(organizationId: string, userId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: `${this.base(organizationId)}/users/${encodeURIComponent(userId)}/deprovision`,
    });
  }

  private base(organizationId: string): string {
    return `/organizations/${encodeURIComponent(organizationId)}/identity`;
  }

  private list(
    organizationId: string,
    resource: string,
  ): Promise<readonly Record<string, unknown>[]> {
    return this.client.request<readonly Record<string, unknown>[]>({
      path: `${this.base(organizationId)}/${resource}`,
    });
  }

  private create(
    organizationId: string,
    resource: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `${this.base(organizationId)}/${resource}`,
      body,
    });
  }
}

export class ScimNamespace {
  constructor(private readonly client: HandStack) {}

  endpoint(organizationId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/scim`,
    });
  }

  issueCredential(organizationId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/scim/credential`,
    });
  }

  revokeCredential(organizationId: string): Promise<{ revoked: true }> {
    return this.client.request<{ revoked: true }>({
      method: 'DELETE',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/scim/credential`,
    });
  }
}

export class DirectoryNamespace {
  constructor(private readonly client: HandStack) {}

  users(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.list(organizationId, 'users');
  }

  createUser(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/users`,
      body,
    });
  }

  updateUser(
    organizationId: string,
    userId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/users/${encodeURIComponent(userId)}`,
      body,
    });
  }

  groups(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.list(organizationId, 'groups');
  }

  roles(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.list(organizationId, 'roles');
  }

  permissions(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.list(organizationId, 'permissions');
  }

  memberships(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.list(organizationId, 'group-memberships');
  }

  principalRoles(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.list(organizationId, 'principal-roles');
  }

  rolePermissions(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.list(organizationId, 'role-permissions');
  }

  createGroup(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.create(organizationId, 'groups', body);
  }

  updateGroup(
    organizationId: string,
    groupId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.update(organizationId, 'groups', groupId, body);
  }

  createRole(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.create(organizationId, 'roles', body);
  }

  updateRole(
    organizationId: string,
    roleId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.update(organizationId, 'roles', roleId, body);
  }

  addToGroup(
    organizationId: string,
    groupId: string,
    principalId: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/group-memberships`,
      body: { groupId, principalId },
    });
  }

  removeFromGroup(
    organizationId: string,
    groupId: string,
    principalId: string,
  ): Promise<{ removed: boolean }> {
    return this.client.request<{ removed: boolean }>({
      method: 'DELETE',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/group-memberships`,
      body: { groupId, principalId },
    });
  }

  assignRole(
    organizationId: string,
    principalId: string,
    roleId: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/principal-roles`,
      body: { principalId, roleId },
    });
  }

  unassignRole(
    organizationId: string,
    principalId: string,
    roleId: string,
  ): Promise<{ removed: boolean }> {
    return this.client.request<{ removed: boolean }>({
      method: 'DELETE',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/principal-roles`,
      body: { principalId, roleId },
    });
  }

  grantPermission(
    organizationId: string,
    roleId: string,
    permissionId: string,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/role-permissions`,
      body: { roleId, permissionId },
    });
  }

  revokePermission(
    organizationId: string,
    roleId: string,
    permissionId: string,
  ): Promise<{ removed: boolean }> {
    return this.client.request<{ removed: boolean }>({
      method: 'DELETE',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/role-permissions`,
      body: { roleId, permissionId },
    });
  }

  private list(
    organizationId: string,
    resource: string,
  ): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/${resource}`,
    });
  }

  private create(
    organizationId: string,
    resource: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/${resource}`,
      body,
    });
  }

  private update(
    organizationId: string,
    resource: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/${resource}/${encodeURIComponent(id)}`,
      body,
    });
  }
}

export class BudgetsNamespace {
  constructor(private readonly client: HandStack) {}

  list(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/budgets`,
    });
  }

  create(organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/budgets`,
      body,
    });
  }

  usage(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/usage`,
    });
  }

  pricing(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/pricing/models`,
    });
  }

  createPricing(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/pricing/models`,
      body,
    });
  }
}

export class PoliciesNamespace {
  constructor(private readonly client: HandStack) {}

  list(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/policies`,
    });
  }

  create(organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/policies`,
      body,
    });
  }

  evaluate(
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/policies/evaluate`,
      body,
    });
  }
}

export class ServiceAccountsNamespace {
  constructor(private readonly client: HandStack) {}

  list(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/service-accounts`,
    });
  }

  create(organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/service-accounts`,
      body,
    });
  }

  rotate(organizationId: string, accountId: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/service-accounts/${encodeURIComponent(accountId)}/rotate`,
    });
  }

  revoke(organizationId: string, accountId: string): Promise<{ revoked: boolean }> {
    return this.client.request<{ revoked: boolean }>({
      method: 'PATCH',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/service-accounts/${encodeURIComponent(accountId)}/revoke`,
    });
  }
}

export class RoutingNamespace {
  constructor(private readonly client: HandStack) {}

  list(organizationId: string): Promise<ListResponse<Record<string, unknown>>> {
    return this.client.request<ListResponse<Record<string, unknown>>>({
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/routing-policies`,
    });
  }

  create(organizationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: `/api/v1/organizations/${encodeURIComponent(organizationId)}/routing-policies`,
      body,
    });
  }
}

function withQuery(
  path: string,
  options: { readonly cursor?: string; readonly limit?: number },
): string {
  const query = new URLSearchParams();
  if (options.cursor !== undefined) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const encoded = query.toString();
  return encoded === '' ? path : `${path}?${encoded}`;
}
