import { ChatExecutionService, ChatService } from '@handstack/chat';
import type { ExecuteConversationInput, Message } from '@handstack/chat';
import { uuidV7 } from '@handstack/domain';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { ModelAdminRuntimeService } from '../models/model-admin-runtime.service.js';
import { BuiltinMalwareScanner, LocalAttachmentStorage } from './attachment-storage.js';
import { KnowledgeRuntimeService } from '../knowledge/knowledge-runtime.service.js';
import { AgentRuntimeService } from '../agents/agent-runtime.service.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { IdentityStorage } from '@handstack/identity-storage';

@Injectable()
export class ChatRuntimeService {
  readonly chat: ChatService;
  readonly execution: ChatExecutionService;
  private readonly identity: IdentityAdministrationService;

  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(ModelAdminRuntimeService) readonly models: ModelAdminRuntimeService,
    @Inject(LocalAttachmentStorage) readonly attachmentStorage: LocalAttachmentStorage,
    @Inject(BuiltinMalwareScanner) malwareScanner: BuiltinMalwareScanner,
    @Inject(KnowledgeRuntimeService) private readonly knowledge: KnowledgeRuntimeService,
    @Inject(AgentRuntimeService) private readonly agents: AgentRuntimeService,
  ) {
    this.chat = new ChatService(database.adapter, undefined, {
      attachmentStorage,
      malwareScanner,
      maxAttachmentBytes: database.config.attachments.maxBytes,
      storePrompts: () => database.config.privacy.storePrompts,
      storeResponses: () => database.config.privacy.storeResponses,
      storeToolPayloads: () => database.config.privacy.storeToolPayloads,
      redactPii: () => database.config.privacy.redactPii,
    });
    this.identity = new IdentityAdministrationService(new IdentityStorage(database.adapter));
    this.execution = new ChatExecutionService(this.chat, models.execution);
  }

  async startExecution(
    input: ExecuteConversationInput & {
      readonly knowledgeBaseId?: string;
      readonly agentId?: string;
    },
  ): Promise<Message> {
    if (input.agentId !== undefined)
      return this.startAgentExecution({ ...input, agentId: input.agentId });
    const contextMessages =
      input.knowledgeBaseId === undefined ? undefined : await this.contextFor(input);
    const executionInput = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== 'knowledgeBaseId'),
    ) as ExecuteConversationInput;
    const handle = await this.execution.start({
      ...executionInput,
      ...(contextMessages === undefined ? {} : { contextMessages }),
    });
    void handle.completion.catch(() => undefined);
    return handle.message;
  }

  private async startAgentExecution(
    input: ExecuteConversationInput & { readonly agentId: string },
  ): Promise<Message> {
    const history = await this.chat.historyForExecution(
      input.organizationId,
      input.conversationId,
      input.branchId,
    );
    const prompt = [...history]
      .reverse()
      .find((message) => message.role === 'user')
      ?.parts.map((part) => part.text ?? '')
      .join('')
      .trim();
    if (prompt === undefined || prompt === '') throw new Error('Agent chat prompt is required');
    const route = await this.models.execution.resolveRoute({
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
      idempotencyKey: `${input.idempotencyKey}:agent:start`,
      ...(input.parentMessageId === undefined ? {} : { parentMessageId: input.parentMessageId }),
    });
    if (message.status !== 'STREAMING') return message;
    const startedAt = Date.now();
    const completion = this.chat.runStream(message.id, async (signal) => {
      try {
        const permissions = await this.identity.listPrincipalPermissions(
          input.organizationId,
          input.createdBy,
        );
        const result = await this.agents.runPublished({
          organizationId: input.organizationId,
          agentId: input.agentId,
          principalId: input.createdBy,
          prompt,
          permissions,
          channel: 'WEB',
          signal,
        });
        await this.chat.appendStreamEvent({
          organizationId: input.organizationId,
          messageId: message.id,
          type: 'DELTA',
          idempotencyKey: `${input.idempotencyKey}:agent:content`,
          part: { id: uuidV7(), type: 'text', text: result.content },
        });
        await this.chat.appendStreamEvent({
          organizationId: input.organizationId,
          messageId: message.id,
          type: 'USAGE',
          idempotencyKey: `${input.idempotencyKey}:agent:usage`,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd:
            (result.usage.inputTokens * route.pricing.inputPerMillion +
              result.usage.outputTokens * route.pricing.outputPerMillion) /
            1_000_000,
        });
        await this.chat.appendStreamEvent({
          organizationId: input.organizationId,
          messageId: message.id,
          type: 'COMPLETED',
          idempotencyKey: `${input.idempotencyKey}:agent:completed`,
          finishReason: 'stop',
          latencyMs: Date.now() - startedAt,
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        });
      } catch (error) {
        if (signal.aborted) {
          await this.chat.cancelStream({
            organizationId: input.organizationId,
            messageId: message.id,
            idempotencyKey: `${input.idempotencyKey}:agent:cancelled`,
          });
        } else {
          await this.chat.appendStreamEvent({
            organizationId: input.organizationId,
            messageId: message.id,
            type: 'FAILED',
            idempotencyKey: `${input.idempotencyKey}:agent:failed`,
            errorCode: 'AGENT_EXECUTION_FAILED',
            latencyMs: Date.now() - startedAt,
            ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          });
        }
        throw error;
      }
      return this.chat.getMessage(input.organizationId, message.id);
    });
    void completion.catch(() => undefined);
    return message;
  }

  private async contextFor(
    input: ExecuteConversationInput & { readonly knowledgeBaseId?: string },
  ) {
    const history = await this.chat.historyForExecution(
      input.organizationId,
      input.conversationId,
      input.branchId,
    );
    const query = [...history]
      .reverse()
      .find((message) => message.role === 'user')
      ?.parts.map((part) => part.text ?? '')
      .join('')
      .trim();
    if (query === undefined || query === '') return [];
    const results = await this.knowledge.search(
      input.organizationId,
      input.knowledgeBaseId ?? '',
      query,
      input.model,
      input.createdBy,
      5,
    );
    if (results.length === 0) return [];
    return [
      {
        role: 'system' as const,
        content: `Use the following governed knowledge context when relevant. Preserve citations in your answer:\n${results.map((result, index) => `[${String(index + 1)}] ${result.citation.title}: ${result.citation.quote}`).join('\n')}`,
      },
    ];
  }

  async startRevision(input: {
    organizationId: string;
    conversationId: string;
    branchId: string;
    message: Message;
    createdBy: string;
    model: string;
    dataClassification: ExecuteConversationInput['dataClassification'];
    idempotencyKey: string;
  }): Promise<Message> {
    return this.startExecution({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      createdBy: input.createdBy,
      model: input.model,
      dataClassification: input.dataClassification,
      idempotencyKey: input.idempotencyKey,
      pendingMessageId: input.message.id,
      ...(input.message.parentMessageId === undefined
        ? {}
        : { parentMessageId: input.message.parentMessageId }),
    });
  }

  async listPublishedModels(organizationId: string) {
    const page = await this.models.registry.listModels(organizationId);
    return {
      items: page.items
        .filter((model) => model.lifecycle === 'PUBLISHED')
        .map((model) => ({
          id: model.id,
          displayName: model.displayName,
          providerModel: model.providerModel,
          lifecycle: model.lifecycle,
          capabilities: model.capabilities,
        })),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  async listPublishedAgents(organizationId: string) {
    const agents = await this.agents.list(organizationId);
    const items = await Promise.all(
      agents.map(async (agent) => {
        const published = (await this.agents.versionsFor(organizationId, agent.id)).find(
          (version) =>
            version.status === 'PUBLISHED' &&
            (version.configuration?.publishChannels?.includes('WEB') ?? false),
        );
        return published === undefined
          ? undefined
          : { id: agent.id, slug: agent.slug, name: agent.name };
      }),
    );
    return { items: items.filter((item): item is NonNullable<typeof item> => item !== undefined) };
  }
}
