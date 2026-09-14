import { ChatExecutionService, ChatService } from '@handstack/chat';
import type { ExecuteConversationInput, Message } from '@handstack/chat';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { ModelAdminRuntimeService } from '../models/model-admin-runtime.service.js';
import { BuiltinMalwareScanner, LocalAttachmentStorage } from './attachment-storage.js';

@Injectable()
export class ChatRuntimeService {
  readonly chat: ChatService;
  readonly execution: ChatExecutionService;

  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(ModelAdminRuntimeService) readonly models: ModelAdminRuntimeService,
    @Inject(LocalAttachmentStorage) readonly attachmentStorage: LocalAttachmentStorage,
    @Inject(BuiltinMalwareScanner) malwareScanner: BuiltinMalwareScanner,
  ) {
    const configuredLimit = Number.parseInt(
      process.env.HANDSTACK_ATTACHMENT_MAX_BYTES ?? String(25 * 1024 * 1024),
      10,
    );
    if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1)
      throw new Error('HANDSTACK_ATTACHMENT_MAX_BYTES is invalid');
    this.chat = new ChatService(database.adapter, undefined, {
      attachmentStorage,
      malwareScanner,
      maxAttachmentBytes: configuredLimit,
    });
    this.execution = new ChatExecutionService(this.chat, models.execution);
  }

  async startExecution(input: ExecuteConversationInput): Promise<Message> {
    const handle = await this.execution.start(input);
    void handle.completion.catch(() => undefined);
    return handle.message;
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
}
