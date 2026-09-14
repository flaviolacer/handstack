import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseCommandInput,
  type ConverseStreamCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  ChatEvent,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ProviderHealth,
  ProviderUsage,
  ToolCall,
} from '@handstack/models';

export type BedrockErrorCode = 'TIMEOUT' | 'CANCELLED' | 'NETWORK' | 'INVALID_RESPONSE';

export class BedrockProviderError extends Error {
  constructor(readonly code: BedrockErrorCode) {
    super(`Bedrock provider request failed: ${code}`);
    this.name = 'BedrockProviderError';
  }
}

export interface BedrockTransport {
  listFoundationModels(signal: AbortSignal): Promise<unknown>;
  converse(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  converseStream(
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>>;
}

export class AwsSdkBedrockTransport implements BedrockTransport {
  private readonly control: BedrockClient;
  private readonly runtime: BedrockRuntimeClient;

  constructor(region: string) {
    if (region.trim() === '') throw new TypeError('AWS region is required');
    this.control = new BedrockClient({ region });
    this.runtime = new BedrockRuntimeClient({ region });
  }

  async listFoundationModels(signal: AbortSignal): Promise<unknown> {
    return this.control.send(new ListFoundationModelsCommand({}), { abortSignal: signal });
  }

  async converse(input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
    return this.runtime.send(new ConverseCommand(input as unknown as ConverseCommandInput), {
      abortSignal: signal,
    });
  }

  async converseStream(
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>> {
    const output = await this.runtime.send(
      new ConverseStreamCommand(input as unknown as ConverseStreamCommandInput),
      { abortSignal: signal },
    );
    if (output.stream === undefined) throw new BedrockProviderError('INVALID_RESPONSE');
    return output.stream as AsyncIterable<unknown>;
  }
}

export interface BedrockProviderOptions {
  readonly region: string;
  readonly transport?: BedrockTransport;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new BedrockProviderError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

function usage(value: unknown): ProviderUsage {
  const item = object(value);
  if (typeof item.inputTokens !== 'number' || typeof item.outputTokens !== 'number')
    throw new BedrockProviderError('INVALID_RESPONSE');
  return { inputTokens: item.inputTokens, outputTokens: item.outputTokens };
}

function finish(value: unknown): ChatResponse['finishReason'] {
  if (value === 'end_turn' || value === 'stop_sequence') return 'stop';
  if (value === 'max_tokens') return 'length';
  if (value === 'tool_use') return 'tool_call';
  return 'error';
}

function content(value: unknown): { content: string; toolCalls?: ToolCall[] } {
  if (!Array.isArray(value)) throw new BedrockProviderError('INVALID_RESPONSE');
  const text: string[] = [];
  const calls: ToolCall[] = [];
  for (const raw of value) {
    const block = object(raw);
    if (typeof block.text === 'string') text.push(block.text);
    if (block.toolUse !== undefined) {
      const tool = object(block.toolUse);
      if (typeof tool.toolUseId !== 'string' || typeof tool.name !== 'string')
        throw new BedrockProviderError('INVALID_RESPONSE');
      calls.push({ id: tool.toolUseId, name: tool.name, arguments: object(tool.input) });
    }
  }
  return { content: text.join(''), ...(calls.length === 0 ? {} : { toolCalls: calls }) };
}

function requestBody(request: ChatRequest): Readonly<Record<string, unknown>> {
  const system = request.messages
    .filter(({ role }) => role === 'system')
    .map(({ content: text }) => ({ text }));
  return {
    modelId: request.model,
    messages: request.messages
      .filter(({ role }) => role !== 'system')
      .map(({ role, content: text }) => ({
        role: role === 'assistant' ? 'assistant' : 'user',
        content: [{ text }],
      })),
    ...(system.length === 0 ? {} : { system }),
    ...(request.tools === undefined
      ? {}
      : {
          toolConfig: {
            tools: request.tools.map((tool) => ({
              toolSpec: {
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                inputSchema: { json: tool.inputSchema },
              },
            })),
          },
        }),
  };
}

export class BedrockProvider implements LLMProvider {
  private readonly transport: BedrockTransport;
  private readonly now: () => Date;

  constructor(private readonly options: BedrockProviderOptions) {
    this.transport = options.transport ?? new AwsSdkBedrockTransport(options.region);
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
    return this.execute(async (signal) => {
      const output = object(await this.transport.listFoundationModels(signal));
      if (!Array.isArray(output.modelSummaries)) throw new BedrockProviderError('INVALID_RESPONSE');
      return output.modelSummaries
        .map((raw) => object(raw).modelId)
        .filter((id): id is string => typeof id === 'string');
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    return this.execute(async (signal) => {
      const output = object(await this.transport.converse(requestBody(request), signal));
      const message = object(object(output.output).message);
      const result = content(message.content);
      return {
        ...result,
        finishReason: finish(output.stopReason),
        usage: usage(output.usage),
      };
    }, request.signal);
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    const stream = await this.execute(
      (signal) => this.transport.converseStream(requestBody(request), signal),
      request.signal,
    );
    const pending = new Map<number, { id: string; name: string; json: string }>();
    let stopped = false;
    const iterator = stream[Symbol.asyncIterator]();
    for (;;) {
      const next = await this.execute(() => iterator.next(), request.signal);
      if (next.done) break;
      const raw = next.value;
      const event = object(raw);
      if (event.contentBlockStart !== undefined) {
        const startEvent = object(event.contentBlockStart);
        const start = object(startEvent.start);
        if (start.toolUse !== undefined && typeof startEvent.contentBlockIndex === 'number') {
          const tool = object(start.toolUse);
          if (typeof tool.toolUseId !== 'string' || typeof tool.name !== 'string')
            throw new BedrockProviderError('INVALID_RESPONSE');
          pending.set(startEvent.contentBlockIndex, {
            id: tool.toolUseId,
            name: tool.name,
            json: '',
          });
        }
      }
      if (event.contentBlockDelta !== undefined) {
        const deltaEvent = object(event.contentBlockDelta);
        const delta = object(deltaEvent.delta);
        if (typeof delta.text === 'string') yield { type: 'content', delta: delta.text };
        if (delta.toolUse !== undefined && typeof deltaEvent.contentBlockIndex === 'number') {
          const toolDelta = object(delta.toolUse);
          const tool = pending.get(deltaEvent.contentBlockIndex);
          if (tool !== undefined && typeof toolDelta.input === 'string')
            tool.json += toolDelta.input;
        }
      }
      if (event.contentBlockStop !== undefined) {
        const stop = object(event.contentBlockStop);
        if (typeof stop.contentBlockIndex === 'number') {
          const tool = pending.get(stop.contentBlockIndex);
          if (tool !== undefined) {
            let input: unknown;
            try {
              input = JSON.parse(tool.json) as unknown;
            } catch {
              throw new BedrockProviderError('INVALID_RESPONSE');
            }
            yield {
              type: 'tool_call',
              toolCall: { id: tool.id, name: tool.name, arguments: object(input) },
            };
            pending.delete(stop.contentBlockIndex);
          }
        }
      }
      if (event.metadata !== undefined) {
        const metadata = object(event.metadata);
        yield { type: 'usage', usage: usage(metadata.usage) };
      }
      if (event.messageStop !== undefined) {
        const stop = object(event.messageStop);
        stopped = true;
        yield { type: 'done', finishReason: finish(stop.stopReason) };
      }
    }
    if (!stopped || pending.size !== 0) throw new BedrockProviderError('INVALID_RESPONSE');
  }

  private async execute<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    external?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const cancel = () => {
      controller.abort();
    };
    external?.addEventListener('abort', cancel, { once: true });
    if (external?.aborted === true) controller.abort();
    const timer = setTimeout(cancel, this.options.timeoutMs ?? 30_000);
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (error instanceof BedrockProviderError) throw error;
      if (external?.aborted === true) throw new BedrockProviderError('CANCELLED');
      if (controller.signal.aborted) throw new BedrockProviderError('TIMEOUT');
      throw new BedrockProviderError('NETWORK');
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', cancel);
    }
  }
}

export function createBedrockProvider(options: BedrockProviderOptions): BedrockProvider {
  return new BedrockProvider(options);
}
