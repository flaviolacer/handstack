import type { TenantEntity } from '@handstack/domain';

export type DataClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
export type ModelCapability = 'chat' | 'vision' | 'tools' | 'embeddings' | 'reasoning';
export type ModelLifecycle =
  'DRAFT' | 'EVALUATED' | 'APPROVED' | 'PUBLISHED' | 'DEPRECATED' | 'RETIRED';

export interface ProviderDefinition extends TenantEntity {
  readonly organizationId: string;
  readonly name: string;
  readonly adapter:
    | 'openai'
    | 'anthropic'
    | 'gemini'
    | 'azure-openai'
    | 'aws-bedrock'
    | 'openrouter'
    | 'ollama'
    | 'vllm'
    | 'openai-compatible';
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly secretReference?: string;
  readonly configuration?: Readonly<Record<string, string>>;
  readonly dataClassificationAllowed: readonly DataClassification[];
}

export interface ModelPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly currency: 'USD';
}

export interface ModelDefinition extends TenantEntity {
  readonly organizationId: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly providerModel: string;
  readonly aliases: readonly string[];
  readonly capabilities: readonly ModelCapability[];
  readonly contextWindow: number;
  readonly pricing: ModelPricing;
  readonly lifecycle: ModelLifecycle;
  readonly evaluationSuiteVersion?: string;
  readonly approvedGateId?: string;
}

export interface Prompt extends TenantEntity {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
}

export interface PromptVariable {
  readonly name: string;
  readonly required: boolean;
  readonly description?: string;
  readonly defaultValue?: string;
}

export interface PromptVersion extends TenantEntity {
  readonly organizationId: string;
  readonly promptId: string;
  readonly versionLabel: string;
  readonly content: string;
  readonly contentDigest: string;
  readonly variables: readonly PromptVariable[];
  readonly modelDefinitionId: string;
  readonly lifecycle: ModelLifecycle;
  readonly evaluationSuiteVersion?: string;
  readonly approvedGateId?: string;
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
}
export interface ToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}
export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly signal?: AbortSignal;
}
export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}
export interface ChatResponse {
  readonly content: string;
  readonly finishReason: 'stop' | 'length' | 'tool_call' | 'error';
  readonly usage: ProviderUsage;
  readonly toolCalls?: readonly ToolCall[];
}
export type ChatEvent =
  | { readonly type: 'content'; readonly delta: string }
  | { readonly type: 'tool_call'; readonly toolCall: ToolCall }
  | { readonly type: 'usage'; readonly usage: ProviderUsage }
  | { readonly type: 'done'; readonly finishReason: ChatResponse['finishReason'] };

export interface ProviderHealth {
  readonly status: 'healthy' | 'degraded' | 'unavailable';
  readonly checkedAt: Date;
}

export interface LLMProvider {
  health(): Promise<ProviderHealth>;
  listModels(): Promise<readonly string[]>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatEvent>;
  embed?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

export interface EmbeddingRequest {
  readonly model: string;
  readonly input: readonly string[];
  readonly signal?: AbortSignal;
}
export interface EmbeddingResponse {
  readonly vectors: readonly (readonly number[])[];
  readonly usage: { readonly promptTokens: number; readonly totalTokens: number };
}

export interface EvaluationRunInput {
  readonly organizationId: string;
  readonly modelDefinitionId: string;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly promptVersionId?: string;
  readonly promptContentDigest?: string;
}
export interface EvaluationRunResult {
  readonly runId: string;
  readonly datasetVersion: string;
  readonly passed: boolean;
  readonly scores: Readonly<Record<string, number>>;
}
export interface EvaluationGateInput extends EvaluationRunInput {
  readonly result: EvaluationRunResult;
}
export interface EvaluationGateDecision {
  readonly passed: boolean;
  readonly reasons: readonly string[];
}
export interface EvaluationProvider {
  run(input: EvaluationRunInput): Promise<EvaluationRunResult>;
  validateGate(input: EvaluationGateInput): Promise<EvaluationGateDecision>;
}

export interface EvaluationGate extends TenantEntity {
  readonly organizationId: string;
  readonly modelDefinitionId: string;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly datasetVersion: string;
  readonly runId: string;
  readonly passed: boolean;
  readonly evaluatedAt: Date;
  readonly scores: Readonly<Record<string, number>>;
}

export interface ModelApproval extends TenantEntity {
  readonly organizationId: string;
  readonly modelDefinitionId: string;
  readonly promptVersionId?: string;
  readonly gateId: string;
  readonly approvedBy: string;
  readonly approvedAt: Date;
  readonly expiresAt?: Date;
  readonly justification?: string;
  readonly override: boolean;
}

export interface PromptEvaluationGate extends EvaluationGate {
  readonly promptVersionId: string;
  readonly promptContentDigest: string;
}

export type AiGovernanceOperation =
  | 'provider.register'
  | 'model.register'
  | 'evaluation.dataset.register'
  | 'evaluation.suite.register'
  | 'evaluation.run'
  | 'evaluation.gate.validate'
  | 'model.gate.record'
  | 'model.approve'
  | 'model.publish'
  | 'prompt.register'
  | 'prompt.version.register'
  | 'prompt.gate.record'
  | 'prompt.approve'
  | 'prompt.publish'
  | 'model.resolve'
  | 'model.chat'
  | 'model.stream'
  | 'model.embed';

export interface AiGovernanceTelemetry {
  measure<T>(operation: AiGovernanceOperation, work: () => Promise<T>): Promise<T>;
  measureStream<T>(
    operation: AiGovernanceOperation,
    work: () => AsyncIterable<T>,
  ): AsyncIterable<T>;
}

export type ModelAuditEventType =
  | 'PROVIDER_REGISTERED'
  | 'MODEL_REGISTERED'
  | 'EVALUATION_DATASET_REGISTERED'
  | 'EVALUATION_SUITE_REGISTERED'
  | 'EVALUATION_RUN_COMPLETED'
  | 'MODEL_GATE_RECORDED'
  | 'MODEL_APPROVED'
  | 'MODEL_APPROVAL_OVERRIDDEN'
  | 'MODEL_PUBLISHED'
  | 'PROMPT_REGISTERED'
  | 'PROMPT_VERSION_REGISTERED'
  | 'PROMPT_GATE_RECORDED'
  | 'PROMPT_APPROVED'
  | 'PROMPT_APPROVAL_OVERRIDDEN'
  | 'PROMPT_PUBLISHED'
  | 'RED_TEAM_CAMPAIGN_REGISTERED'
  | 'RED_TEAM_CAMPAIGN_COMPLETED';

export interface ModelAuditEvent extends TenantEntity {
  readonly organizationId: string;
  readonly eventType: ModelAuditEventType;
  readonly resourceType:
    | 'provider'
    | 'model'
    | 'prompt'
    | 'prompt_version'
    | 'evaluation_dataset'
    | 'evaluation_suite'
    | 'evaluation_run'
    | 'red_team_campaign';
  readonly resourceId: string;
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}
