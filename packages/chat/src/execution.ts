import type { ModelExecutionInput, ResolvedModelRoute } from '@handstack/model-runtime';
import type {
  ChatEvent,
  ChatMessage,
  DataClassification,
  ProviderUsage,
  ToolDefinition,
} from '@handstack/models';
import { uuidV7 } from '@handstack/domain';
import type { ChatService, Message } from './index.js';

export interface ExecuteConversationInput {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly branchId: string;
  readonly createdBy: string;
  readonly model: string;
  readonly dataClassification: DataClassification;
  readonly idempotencyKey: string;
  readonly parentMessageId?: string;
  readonly pendingMessageId?: string;
  readonly tools?: readonly ToolDefinition[];
  readonly traceId?: string;
}

export interface ConversationModelRuntime {
  resolveRoute(input: {
    organizationId: string;
    model: string;
    dataClassification: DataClassification;
  }): Promise<ResolvedModelRoute>;
  stream(input: ModelExecutionInput): AsyncIterable<ChatEvent>;
}

export interface ChatExecutionHandle {
  readonly message: Message;
  readonly completion: Promise<Message>;
}

export class ChatExecutionService {
  constructor(
    private readonly chat: ChatService,
    private readonly runtime: ConversationModelRuntime,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async execute(input: ExecuteConversationInput): Promise<Message> {
    return (await this.start(input)).completion;
  }

  async start(input: ExecuteConversationInput): Promise<ChatExecutionHandle> {
    const history = (
      await this.chat.history(input.organizationId, input.conversationId, input.branchId)
    ).filter((message) => message.id !== input.pendingMessageId);
    const route = await this.runtime.resolveRoute({
      organizationId: input.organizationId,
      model: input.model,
      dataClassification: input.dataClassification,
    });
    const message = await this.chat.startStream({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      createdBy: input.createdBy,
      modelDefinitionId: route.modelDefinitionId,
      providerId: route.providerId,
      idempotencyKey: `${input.idempotencyKey}:start`,
      ...(input.pendingMessageId === undefined ? {} : { pendingMessageId: input.pendingMessageId }),
      ...(input.parentMessageId === undefined ? {} : { parentMessageId: input.parentMessageId }),
    });
    if (message.status !== 'STREAMING') return { message, completion: Promise.resolve(message) };
    const startedAt = this.clock();
    const completion = this.chat.runStream(message.id, async (signal) => {
      let sequence = 0;
      let completed = false;
      try {
        for await (const event of this.runtime.stream({
          organizationId: input.organizationId,
          model: input.model,
          dataClassification: input.dataClassification,
          messages: this.toModelMessages(history),
          signal,
          ...(input.tools === undefined ? {} : { tools: input.tools }),
        })) {
          sequence += 1;
          const eventKey = `${input.idempotencyKey}:event:${String(sequence)}`;
          if (event.type === 'content') {
            await this.chat.appendStreamEvent({
              organizationId: input.organizationId,
              messageId: message.id,
              type: 'DELTA',
              idempotencyKey: eventKey,
              part: { id: uuidV7(this.clock()), type: 'text', text: event.delta },
            });
          } else if (event.type === 'tool_call') {
            await this.chat.appendStreamEvent({
              organizationId: input.organizationId,
              messageId: message.id,
              type: 'DELTA',
              idempotencyKey: eventKey,
              part: { id: event.toolCall.id, type: 'tool_call', data: { ...event.toolCall } },
            });
          } else if (event.type === 'usage') {
            await this.persistUsage(event.usage, route, input.organizationId, message.id, eventKey);
          } else {
            completed = true;
            await this.chat.appendStreamEvent({
              organizationId: input.organizationId,
              messageId: message.id,
              type: 'COMPLETED',
              idempotencyKey: eventKey,
              finishReason: event.finishReason,
              latencyMs: Math.max(0, this.clock() - startedAt),
              ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
            });
          }
        }
        if (!completed) throw new Error('Provider stream ended without a completion event');
      } catch (error) {
        if (signal.aborted) {
          await this.persistCancellation(input, message.id);
        } else {
          await this.chat.appendStreamEvent({
            organizationId: input.organizationId,
            messageId: message.id,
            type: 'FAILED',
            idempotencyKey: `${input.idempotencyKey}:failed`,
            errorCode: 'PROVIDER_STREAM_FAILED',
            latencyMs: Math.max(0, this.clock() - startedAt),
            ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          });
        }
        throw error;
      }
      return this.chat.getMessage(input.organizationId, message.id);
    });
    return { message, completion };
  }

  private toModelMessages(messages: readonly Message[]): readonly ChatMessage[] {
    return messages.map((message) => ({
      role: message.role,
      content: message.parts
        .filter((part) => part.type === 'text' || part.type === 'reasoning')
        .map((part) => part.text ?? '')
        .join(''),
    }));
  }

  private async persistUsage(
    usage: ProviderUsage,
    route: ResolvedModelRoute,
    organizationId: string,
    messageId: string,
    idempotencyKey: string,
  ) {
    const costUsd =
      (usage.inputTokens * route.pricing.inputPerMillion +
        usage.outputTokens * route.pricing.outputPerMillion) /
      1_000_000;
    await this.chat.appendStreamEvent({
      organizationId,
      messageId,
      type: 'USAGE',
      idempotencyKey,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
    });
  }

  private async persistCancellation(input: ExecuteConversationInput, messageId: string) {
    try {
      await this.chat.cancelStream({
        organizationId: input.organizationId,
        messageId,
        idempotencyKey: `${input.idempotencyKey}:cancelled`,
      });
    } catch (error) {
      const current = await this.chat.getMessage(input.organizationId, messageId);
      if (current.status !== 'CANCELLED') throw error;
    }
  }
}
