import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '@handstack/database';
import { repositoryName, uuidV7, type Repository, type TenantEntity } from '@handstack/domain';

export type ConversationStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETED';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type MessageStatus = 'PENDING' | 'STREAMING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type ChatStreamEventType =
  'STARTED' | 'DELTA' | 'USAGE' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type MessagePartType =
  | 'text'
  | 'image'
  | 'audio'
  | 'file'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning'
  | 'citation'
  | 'artifact'
  | 'error';

export interface Conversation extends TenantEntity {
  readonly organizationId: string;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly createdBy: string;
  readonly activeBranchId: string;
}

export interface ConversationParticipant extends TenantEntity {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly principalId: string;
  readonly role: 'OWNER' | 'MEMBER' | 'VIEWER';
}

export type ChatAuditOperation =
  | 'CONVERSATION_CREATED'
  | 'CONVERSATION_ARCHIVED'
  | 'CONVERSATION_RESTORED'
  | 'CONVERSATION_DELETED';

export interface ChatAuditEvent extends TenantEntity {
  readonly organizationId: string;
  readonly operation: ChatAuditOperation;
  readonly conversationId: string;
  readonly actorId: string;
  readonly outcome: 'SUCCEEDED';
}

export interface ConversationBranch extends TenantEntity {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly name: string;
  readonly parentBranchId?: string;
  readonly forkedFromMessageId?: string;
  readonly replacesMessageId?: string;
  readonly createdBy: string;
}

export interface MessagePart {
  readonly id: string;
  readonly type: MessagePartType;
  readonly mimeType?: string;
  readonly text?: string;
  readonly uri?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface Message extends TenantEntity {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly branchId: string;
  readonly sequence: number;
  readonly role: MessageRole;
  readonly parts: readonly MessagePart[];
  readonly status: MessageStatus;
  readonly modelDefinitionId?: string;
  readonly providerId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly latencyMs?: number;
  readonly traceId?: string;
  readonly parentMessageId?: string;
  readonly createdBy: string;
}

/** Safe usage projection; message parts and prompt/response content are never exposed. */
export interface ChatUsageRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly scopeType: 'USER';
  readonly scopeKey: string;
  readonly provider?: string;
  readonly model?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs?: number;
  readonly outcome: 'SUCCESS' | 'ERROR';
}

export interface ChatStreamEvent extends TenantEntity {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly branchId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly type: ChatStreamEventType;
  readonly idempotencyKey: string;
  readonly part?: MessagePart;
  readonly errorCode?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly finishReason?: 'stop' | 'length' | 'tool_call' | 'error';
}

export interface StreamReplay {
  readonly events: readonly ChatStreamEvent[];
  readonly nextCursor?: number;
}

export interface ChatPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      !('offset' in value) ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 0
    )
      throw new Error('Invalid cursor');
    return value.offset as number;
  } catch {
    throw new Error('Invalid cursor');
  }
}

function page<T>(items: readonly T[], cursor: string | undefined, limit: number): ChatPage<T> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid limit');
  const offset = decodeOffset(cursor);
  const selected = items.slice(offset, offset + limit);
  const nextOffset = offset + selected.length;
  return {
    items: selected,
    ...(nextOffset < items.length ? { nextCursor: encodeOffset(nextOffset) } : {}),
  };
}

export type DataClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

export interface Attachment extends TenantEntity {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly originalName: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly status: 'READY' | 'REJECTED' | 'DELETED';
  readonly dataClassification: DataClassification;
  readonly createdBy: string;
}

export interface Citation extends TenantEntity {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly sourceUri: string;
  readonly title: string;
  readonly locator?: string;
  readonly createdBy: string;
}

export interface Artifact extends TenantEntity {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly kind: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly createdBy: string;
}

export interface AttachmentStorage {
  put(key: string, content: Uint8Array, mimeType: string): Promise<void>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export interface MalwareScanner {
  scan(input: {
    content: Uint8Array;
    filename: string;
    mimeType: string;
  }): Promise<'CLEAN' | 'INFECTED'>;
}

export interface ChatServiceOptions {
  readonly attachmentStorage?: AttachmentStorage;
  readonly malwareScanner?: MalwareScanner;
  readonly maxAttachmentBytes?: number;
  readonly storePrompts?: boolean | (() => boolean);
  readonly storeResponses?: boolean | (() => boolean);
  readonly storeToolPayloads?: boolean | (() => boolean);
  readonly redactPii?: boolean | (() => boolean);
}

const conversations = repositoryName('conversations');
const participants = repositoryName('conversation-participants');
const branches = repositoryName('conversation-branches');
const messages = repositoryName('conversation-messages');
const streamEvents = repositoryName('conversation-stream-events');
const attachments = repositoryName('conversation-attachments');
const citations = repositoryName('conversation-citations');
const artifacts = repositoryName('conversation-artifacts');
const auditEvents = repositoryName('chat-audit-events');

export const chatSchema = {
  version: 1,
  repositories: {
    conversations,
    participants,
    branches,
    messages,
    streamEvents,
    attachments,
    citations,
    artifacts,
    auditEvents,
  },
} as const;

async function all<T extends TenantEntity>(repository: Repository<T>, organizationId: string) {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list(organizationId, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

function redactPiiText(value: string): string {
  return value
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[REDACTED_CPF]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(
      /(?<!\w)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,3}\)|\d{2,3})[\s.-]?\d{4,5}[\s.-]?\d{4}(?!\w)/g,
      '[REDACTED_PHONE]',
    );
}

function redactPiiValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactPiiText(value);
  if (Array.isArray(value)) return value.map((item) => redactPiiValue(item, depth + 1));
  if (typeof value !== 'object' || value === null || depth >= 12) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactPiiValue(item, depth + 1)]),
  );
}

function redactPiiPart(part: MessagePart): MessagePart {
  return {
    ...part,
    ...(part.text === undefined ? {} : { text: redactPiiText(part.text) }),
    ...(part.uri === undefined ? {} : { uri: redactPiiText(part.uri) }),
    ...(part.data === undefined
      ? {}
      : { data: redactPiiValue(part.data) as Readonly<Record<string, unknown>> }),
  };
}

export class ChatService {
  private readonly activeStreams = new Map<string, AbortController>();
  private readonly transientPrompts = new Map<
    string,
    {
      readonly organizationId: string;
      readonly parts: readonly MessagePart[];
      readonly expiresAt: number;
    }
  >();

  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
    private readonly options: ChatServiceOptions = {},
  ) {}

  private privacySetting(value: boolean | (() => boolean) | undefined): boolean {
    return typeof value === 'function' ? value() : (value ?? true);
  }

  async createConversation(input: {
    organizationId: string;
    title: string;
    createdBy: string;
  }): Promise<Conversation> {
    if (input.organizationId === '' || input.title.trim() === '' || input.createdBy === '')
      throw new Error('Conversation input is incomplete');
    const timestamp = this.now();
    const conversationId = uuidV7(timestamp.getTime());
    const branchId = uuidV7(timestamp.getTime());
    return this.adapter.run(async (context) => {
      const conversation = await context.repository<Conversation>(conversations).insert({
        id: conversationId,
        tenantId: input.organizationId,
        organizationId: input.organizationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        title: input.title.trim(),
        status: 'ACTIVE',
        createdBy: input.createdBy,
        activeBranchId: branchId,
      });
      await context.repository<ConversationBranch>(branches).insert({
        id: branchId,
        tenantId: input.organizationId,
        organizationId: input.organizationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        conversationId,
        name: 'main',
        createdBy: input.createdBy,
      });
      await context.repository<ConversationParticipant>(participants).insert({
        id: uuidV7(timestamp.getTime()),
        tenantId: input.organizationId,
        organizationId: input.organizationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        conversationId,
        principalId: input.createdBy,
        role: 'OWNER',
      });
      await this.insertAudit(context.repository<ChatAuditEvent>(auditEvents), {
        organizationId: input.organizationId,
        conversationId,
        actorId: input.createdBy,
        operation: 'CONVERSATION_CREATED',
        timestamp,
      });
      return conversation;
    });
  }

  async archiveConversation(input: {
    organizationId: string;
    conversationId: string;
    actorId: string;
  }): Promise<Conversation> {
    return this.changeConversationStatus(input, 'ARCHIVED', 'CONVERSATION_ARCHIVED');
  }

  async restoreConversation(input: {
    organizationId: string;
    conversationId: string;
    actorId: string;
  }): Promise<Conversation> {
    return this.changeConversationStatus(input, 'ACTIVE', 'CONVERSATION_RESTORED');
  }

  async deleteConversation(input: {
    organizationId: string;
    conversationId: string;
    actorId: string;
  }): Promise<Conversation> {
    return this.deleteConversationInternal(input, true);
  }

  /** Deletes an expired conversation as a privacy lifecycle action, recording its system actor. */
  async deleteConversationForRetention(input: {
    organizationId: string;
    conversationId: string;
    actorId: string;
  }): Promise<Conversation> {
    return this.deleteConversationInternal(input, false);
  }

  private async deleteConversationInternal(
    input: { organizationId: string; conversationId: string; actorId: string },
    enforceOwnership: boolean,
  ): Promise<Conversation> {
    const conversation = await this.adapter
      .repository<Conversation>(conversations)
      .findById(input.organizationId, input.conversationId);
    if (conversation === undefined || conversation.status === 'DELETED')
      throw new Error('Conversation not found');
    if (enforceOwnership)
      await this.requireOwner(
        this.adapter.repository<ConversationParticipant>(participants),
        input.organizationId,
        input.conversationId,
        input.actorId,
      );
    const storedAttachments = (
      await all(this.adapter.repository<Attachment>(attachments), input.organizationId)
    ).filter(
      (attachment) =>
        attachment.conversationId === input.conversationId && attachment.status !== 'DELETED',
    );
    if (this.options.attachmentStorage !== undefined)
      for (const attachment of storedAttachments)
        await this.options.attachmentStorage.delete(attachment.storageKey);
    return this.adapter.run(async (context) => {
      const repository = context.repository<Conversation>(conversations);
      const conversation = await repository.findById(input.organizationId, input.conversationId);
      if (conversation === undefined || conversation.status === 'DELETED')
        throw new Error('Conversation not found');
      if (enforceOwnership)
        await this.requireOwner(
          context.repository<ConversationParticipant>(participants),
          input.organizationId,
          input.conversationId,
          input.actorId,
        );
      const timestamp = this.now();
      const collections = [
        [participants, 'conversationId'],
        [branches, 'conversationId'],
        [messages, 'conversationId'],
        [streamEvents, 'conversationId'],
        [attachments, 'conversationId'],
        [citations, 'conversationId'],
        [artifacts, 'conversationId'],
      ] as const;
      for (const [name] of collections) {
        const childRepository = context.repository<TenantEntity & { conversationId: string }>(name);
        const children = (await all(childRepository, input.organizationId)).filter(
          (item) => item.conversationId === input.conversationId,
        );
        for (const child of children)
          await childRepository.delete(input.organizationId, child.id, child.version);
      }
      const deleted = await repository.update(
        {
          ...conversation,
          version: conversation.version + 1,
          updatedAt: timestamp,
          status: 'DELETED',
          title: 'Deleted conversation',
          createdBy: 'deleted',
        },
        conversation.version,
      );
      await this.insertAudit(context.repository<ChatAuditEvent>(auditEvents), {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        actorId: input.actorId,
        operation: 'CONVERSATION_DELETED',
        timestamp,
      });
      return deleted;
    });
  }

  async listAuditEvents(organizationId: string): Promise<readonly ChatAuditEvent[]> {
    return all(this.adapter.repository<ChatAuditEvent>(auditEvents), organizationId);
  }

  async listConversations(organizationId: string, principalId: string) {
    const participantItems = await all(
      this.adapter.repository<ConversationParticipant>(participants),
      organizationId,
    );
    const visible = new Set(
      participantItems
        .filter((participant) => participant.principalId === principalId)
        .map((participant) => participant.conversationId),
    );
    return (await all(this.adapter.repository<Conversation>(conversations), organizationId))
      .filter((conversation) => visible.has(conversation.id) && conversation.status !== 'DELETED')
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }

  async listConversationsPage(
    organizationId: string,
    principalId: string,
    cursor?: string,
    limit = 50,
  ): Promise<ChatPage<Conversation>> {
    return page(await this.listConversations(organizationId, principalId), cursor, limit);
  }

  async requireParticipant(
    organizationId: string,
    conversationId: string,
    principalId: string,
    write = false,
  ) {
    const conversation = await this.adapter
      .repository<Conversation>(conversations)
      .findById(organizationId, conversationId);
    const participantItems = await all(
      this.adapter.repository<ConversationParticipant>(participants),
      organizationId,
    );
    const participant = participantItems.find(
      (candidate) =>
        candidate.conversationId === conversationId && candidate.principalId === principalId,
    );
    if (
      conversation?.status !== 'ACTIVE' ||
      participant === undefined ||
      (write && participant.role === 'VIEWER')
    )
      throw new Error(
        write ? 'Conversation write permission is required' : 'Conversation not found',
      );
    return participant;
  }

  async appendMessage(input: {
    organizationId: string;
    conversationId: string;
    branchId: string;
    role: MessageRole;
    parts: readonly MessagePart[];
    status?: MessageStatus;
    createdBy: string;
    modelDefinitionId?: string;
    providerId?: string;
    parentMessageId?: string;
  }): Promise<Message> {
    if (
      input.parts.length === 0 ||
      new Set(input.parts.map(({ id }) => id)).size !== input.parts.length
    )
      throw new Error('Message parts must be non-empty and uniquely identified');
    return this.adapter.run(async (context) => {
      const conversation = await context
        .repository<Conversation>(conversations)
        .findById(input.organizationId, input.conversationId);
      const branch = await context
        .repository<ConversationBranch>(branches)
        .findById(input.organizationId, input.branchId);
      if (conversation?.status !== 'ACTIVE' || branch?.conversationId !== conversation.id)
        throw new Error('Active conversation branch not found');
      const participantItems = await all(
        context.repository<ConversationParticipant>(participants),
        input.organizationId,
      );
      if (
        !participantItems.some(
          (item) =>
            item.conversationId === conversation.id &&
            item.principalId === input.createdBy &&
            item.role !== 'VIEWER',
        )
      )
        throw new Error('Conversation write permission is required');
      await this.validatePartReferences(
        context,
        input.organizationId,
        conversation.id,
        input.parts,
      );
      const storedParts = input.parts.map((part) => this.storedPart(part, input.role));
      const messageItems = await all(context.repository<Message>(messages), input.organizationId);
      const history = messageItems.filter((item) => item.branchId === branch.id);
      let baseline = 0;
      if (branch.forkedFromMessageId !== undefined) {
        const source = await context
          .repository<Message>(messages)
          .findById(input.organizationId, branch.forkedFromMessageId);
        if (source === undefined) throw new Error('Branch source message not found');
        baseline = source.sequence - (branch.replacesMessageId === source.id ? 1 : 0);
      }
      const sequence =
        history.reduce((maximum, item) => Math.max(maximum, item.sequence), baseline) + 1;
      const timestamp = this.now();
      const persisted = await context.repository<Message>(messages).insert({
        id: uuidV7(timestamp.getTime()),
        tenantId: input.organizationId,
        organizationId: input.organizationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        conversationId: conversation.id,
        branchId: branch.id,
        sequence,
        role: input.role,
        parts: storedParts,
        status: input.status ?? 'COMPLETED',
        createdBy: input.createdBy,
        ...(input.modelDefinitionId === undefined
          ? {}
          : { modelDefinitionId: input.modelDefinitionId }),
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        ...(input.parentMessageId === undefined ? {} : { parentMessageId: input.parentMessageId }),
      });
      if ((input.role === 'user' || input.role === 'system') && !this.storePromptsEnabled()) {
        const transientParts = this.privacySetting(this.options.redactPii)
          ? input.parts.map(redactPiiPart)
          : input.parts;
        this.transientPrompts.set(persisted.id, {
          organizationId: input.organizationId,
          parts: transientParts,
          expiresAt: this.now().getTime() + 15 * 60_000,
        });
        while (this.transientPrompts.size > 512) {
          const oldest = this.transientPrompts.keys().next().value;
          if (oldest === undefined) break;
          this.transientPrompts.delete(oldest);
        }
      }
      return persisted;
    });
  }

  async createBranch(input: {
    organizationId: string;
    conversationId: string;
    fromMessageId: string;
    name: string;
    createdBy: string;
  }): Promise<ConversationBranch> {
    return this.adapter.run(async (context) => {
      const conversation = await context
        .repository<Conversation>(conversations)
        .findById(input.organizationId, input.conversationId);
      const source = await context
        .repository<Message>(messages)
        .findById(input.organizationId, input.fromMessageId);
      if (
        conversation?.status !== 'ACTIVE' ||
        source?.conversationId !== input.conversationId ||
        input.name.trim() === ''
      )
        throw new Error('Branch source message not found');
      const participantItems = await all(
        context.repository<ConversationParticipant>(participants),
        input.organizationId,
      );
      if (
        !participantItems.some(
          (item) =>
            item.conversationId === input.conversationId &&
            item.principalId === input.createdBy &&
            item.role !== 'VIEWER',
        )
      )
        throw new Error('Conversation write permission is required');
      const timestamp = this.now();
      return context.repository<ConversationBranch>(branches).insert({
        id: uuidV7(timestamp.getTime()),
        tenantId: input.organizationId,
        organizationId: input.organizationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        conversationId: input.conversationId,
        name: input.name.trim(),
        parentBranchId: source.branchId,
        forkedFromMessageId: source.id,
        createdBy: input.createdBy,
      });
    });
  }

  async storeAttachment(input: {
    organizationId: string;
    conversationId: string;
    createdBy: string;
    filename: string;
    mimeType: string;
    content: Uint8Array;
    dataClassification?: DataClassification;
  }): Promise<Attachment> {
    const storage = this.options.attachmentStorage;
    const scanner = this.options.malwareScanner;
    if (storage === undefined || scanner === undefined)
      throw new Error('Attachment storage and malware scanner are required');
    this.validateAttachment(input.filename, input.mimeType, input.content.byteLength);
    await this.requireConversationWriter(
      input.organizationId,
      input.conversationId,
      input.createdBy,
    );
    if (
      (await scanner.scan({
        content: input.content,
        filename: input.filename,
        mimeType: input.mimeType,
      })) !== 'CLEAN'
    )
      throw new Error('Attachment rejected by malware scanner');
    const timestamp = this.now();
    const id = uuidV7(timestamp.getTime());
    const extension = input.filename.slice(input.filename.lastIndexOf('.')).toLowerCase();
    const storageKey = `${input.organizationId}/${input.conversationId}/${id}${extension}`;
    await storage.put(storageKey, input.content, input.mimeType);
    try {
      return await this.adapter.repository<Attachment>(attachments).insert({
        id,
        tenantId: input.organizationId,
        organizationId: input.organizationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        conversationId: input.conversationId,
        originalName: input.filename,
        storageKey,
        mimeType: input.mimeType,
        sizeBytes: input.content.byteLength,
        sha256: createHash('sha256').update(input.content).digest('hex'),
        status: 'READY',
        dataClassification: input.dataClassification ?? 'INTERNAL',
        createdBy: input.createdBy,
      });
    } catch (error) {
      await storage.delete(storageKey);
      throw error;
    }
  }

  async attachmentUrl(organizationId: string, attachmentId: string, expiresInSeconds = 300) {
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 3600)
      throw new Error('Invalid signed URL lifetime');
    const attachment = await this.adapter
      .repository<Attachment>(attachments)
      .findById(organizationId, attachmentId);
    if (attachment?.status !== 'READY') throw new Error('Attachment not found');
    const storage = this.options.attachmentStorage;
    if (storage === undefined) throw new Error('Attachment storage is required');
    return storage.signedUrl(attachment.storageKey, expiresInSeconds);
  }

  async getAttachment(organizationId: string, attachmentId: string): Promise<Attachment> {
    const attachment = await this.adapter
      .repository<Attachment>(attachments)
      .findById(organizationId, attachmentId);
    if (attachment === undefined || attachment.status === 'DELETED')
      throw new Error('Attachment not found');
    return attachment;
  }

  async deleteAttachment(input: {
    organizationId: string;
    conversationId: string;
    attachmentId: string;
    deletedBy: string;
  }): Promise<Attachment> {
    await this.requireConversationWriter(
      input.organizationId,
      input.conversationId,
      input.deletedBy,
    );
    const attachment = await this.getAttachment(input.organizationId, input.attachmentId);
    if (attachment.conversationId !== input.conversationId) throw new Error('Attachment not found');
    const storage = this.options.attachmentStorage;
    if (storage === undefined) throw new Error('Attachment storage is required');
    await storage.delete(attachment.storageKey);
    return this.adapter.repository<Attachment>(attachments).update(
      {
        ...attachment,
        status: 'DELETED',
        version: attachment.version + 1,
        updatedAt: this.now(),
      },
      attachment.version,
    );
  }

  async createCitation(input: {
    organizationId: string;
    conversationId: string;
    createdBy: string;
    sourceUri: string;
    title: string;
    locator?: string;
  }): Promise<Citation> {
    await this.requireConversationWriter(
      input.organizationId,
      input.conversationId,
      input.createdBy,
    );
    const uri = new URL(input.sourceUri);
    if (!['https:', 'http:'].includes(uri.protocol) || input.title.trim() === '')
      throw new Error('Citation metadata is invalid');
    const timestamp = this.now();
    return this.adapter.repository<Citation>(citations).insert({
      id: uuidV7(timestamp.getTime()),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      conversationId: input.conversationId,
      sourceUri: uri.toString(),
      title: input.title.trim(),
      createdBy: input.createdBy,
      ...(input.locator === undefined ? {} : { locator: input.locator }),
    });
  }

  async createArtifact(input: {
    organizationId: string;
    conversationId: string;
    createdBy: string;
    title: string;
    kind: string;
    storageKey: string;
    mimeType: string;
  }): Promise<Artifact> {
    await this.requireConversationWriter(
      input.organizationId,
      input.conversationId,
      input.createdBy,
    );
    if (
      [input.title, input.kind, input.storageKey, input.mimeType].some(
        (value) => value.trim() === '',
      )
    )
      throw new Error('Artifact metadata is invalid');
    const timestamp = this.now();
    return this.adapter.repository<Artifact>(artifacts).insert({
      id: uuidV7(timestamp.getTime()),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      conversationId: input.conversationId,
      title: input.title.trim(),
      kind: input.kind.trim(),
      storageKey: input.storageKey,
      mimeType: input.mimeType,
      createdBy: input.createdBy,
    });
  }

  async editMessage(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    parts: readonly MessagePart[];
    createdBy: string;
  }): Promise<{ branch: ConversationBranch; message: Message }> {
    const source = await this.requireMessage(
      input.organizationId,
      input.conversationId,
      input.messageId,
    );
    if (source.role !== 'user') throw new Error('Only user messages can be edited');
    const branch = await this.createReplacementBranch({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      source,
      name: `edit-${String(source.sequence)}`,
      createdBy: input.createdBy,
    });
    const message = await this.appendMessage({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      branchId: branch.id,
      role: 'user',
      parts: input.parts,
      createdBy: input.createdBy,
      ...(source.parentMessageId === undefined ? {} : { parentMessageId: source.parentMessageId }),
    });
    return { branch, message };
  }

  async regenerateMessage(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    createdBy: string;
    modelDefinitionId?: string;
    providerId?: string;
  }): Promise<{ branch: ConversationBranch; message: Message }> {
    const source = await this.requireMessage(
      input.organizationId,
      input.conversationId,
      input.messageId,
    );
    if (source.role !== 'assistant') throw new Error('Only assistant messages can be regenerated');
    return this.reviseAssistant(input, source, 'regenerate');
  }

  async retryMessage(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    createdBy: string;
  }): Promise<{ branch: ConversationBranch; message: Message }> {
    const source = await this.requireMessage(
      input.organizationId,
      input.conversationId,
      input.messageId,
    );
    if (source.role !== 'assistant' || !['FAILED', 'CANCELLED'].includes(source.status))
      throw new Error('Only failed or cancelled assistant messages can be retried');
    return this.reviseAssistant(input, source, 'retry');
  }

  async startStream(input: {
    organizationId: string;
    conversationId: string;
    branchId: string;
    createdBy: string;
    modelDefinitionId: string;
    providerId: string;
    parentMessageId?: string;
    pendingMessageId?: string;
    idempotencyKey: string;
  }): Promise<Message> {
    this.assertIdempotencyKey(input.idempotencyKey);
    const existingStart = (
      await all(this.adapter.repository<ChatStreamEvent>(streamEvents), input.organizationId)
    ).find((event) => event.type === 'STARTED' && event.idempotencyKey === input.idempotencyKey);
    if (existingStart !== undefined) {
      const existingMessage = await this.adapter
        .repository<Message>(messages)
        .findById(input.organizationId, existingStart.messageId);
      if (
        existingMessage?.conversationId !== input.conversationId ||
        existingMessage.branchId !== input.branchId ||
        existingMessage.modelDefinitionId !== input.modelDefinitionId ||
        existingMessage.providerId !== input.providerId
      )
        throw new Error('Idempotency key conflicts with a different stream');
      return existingMessage;
    }
    let message: Message;
    if (input.pendingMessageId === undefined) {
      message = await this.appendMessage({
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        branchId: input.branchId,
        role: 'assistant',
        parts: [{ id: uuidV7(this.now().getTime()), type: 'text', text: '' }],
        status: 'STREAMING',
        createdBy: input.createdBy,
        modelDefinitionId: input.modelDefinitionId,
        providerId: input.providerId,
        ...(input.parentMessageId === undefined ? {} : { parentMessageId: input.parentMessageId }),
      });
    } else {
      const repository = this.adapter.repository<Message>(messages);
      const pending = await repository.findById(input.organizationId, input.pendingMessageId);
      if (
        pending?.conversationId !== input.conversationId ||
        pending.branchId !== input.branchId ||
        pending.role !== 'assistant' ||
        pending.status !== 'PENDING'
      )
        throw new Error('Pending assistant message is invalid');
      message = await repository.update(
        {
          ...pending,
          version: pending.version + 1,
          updatedAt: this.now(),
          status: 'STREAMING',
          modelDefinitionId: input.modelDefinitionId,
          providerId: input.providerId,
        },
        pending.version,
      );
    }
    await this.appendStreamEvent({
      organizationId: input.organizationId,
      messageId: message.id,
      type: 'STARTED',
      idempotencyKey: input.idempotencyKey,
    });
    return message;
  }

  async appendStreamEvent(input: {
    organizationId: string;
    messageId: string;
    type: ChatStreamEventType;
    idempotencyKey: string;
    part?: MessagePart;
    errorCode?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    finishReason?: ChatStreamEvent['finishReason'];
    latencyMs?: number;
    traceId?: string;
  }): Promise<ChatStreamEvent> {
    const storedPart =
      input.part === undefined ? undefined : this.storedPart(input.part, 'assistant');
    const eventInput = {
      ...input,
      ...(storedPart === undefined ? {} : { part: storedPart }),
    };
    this.assertIdempotencyKey(input.idempotencyKey);
    this.validateStreamEvent(eventInput);
    return this.adapter.run(async (context) => {
      const repository = context.repository<ChatStreamEvent>(streamEvents);
      const existing = (await all(repository, input.organizationId)).find(
        (event) =>
          event.messageId === input.messageId && event.idempotencyKey === input.idempotencyKey,
      );
      if (existing !== undefined) {
        if (
          existing.type !== input.type ||
          JSON.stringify(existing.part) !== JSON.stringify(storedPart) ||
          existing.errorCode !== input.errorCode ||
          existing.inputTokens !== input.inputTokens ||
          existing.outputTokens !== input.outputTokens ||
          existing.costUsd !== input.costUsd ||
          existing.finishReason !== input.finishReason
        )
          throw new Error('Idempotency key conflicts with a different stream event');
        return existing;
      }
      const messageRepository = context.repository<Message>(messages);
      const message = await messageRepository.findById(input.organizationId, input.messageId);
      if (message === undefined) throw new Error('Stream message not found');
      if (message.status !== 'STREAMING') throw new Error('Stream message is already terminal');
      const currentEvents = (await all(repository, input.organizationId)).filter(
        (event) => event.messageId === message.id,
      );
      const sequence =
        currentEvents.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
      const timestamp = this.now();
      const event = await repository.insert({
        id: uuidV7(timestamp.getTime()),
        tenantId: input.organizationId,
        organizationId: input.organizationId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        conversationId: message.conversationId,
        branchId: message.branchId,
        messageId: message.id,
        sequence,
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        ...(storedPart === undefined ? {} : { part: storedPart }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
        ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
        ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
        ...(input.finishReason === undefined ? {} : { finishReason: input.finishReason }),
      });
      let parts = message.parts;
      if (input.type === 'DELTA') {
        const part = storedPart;
        if (part === undefined) throw new Error('Delta stream event requires a message part');
        parts = [...message.parts, part];
      }
      const terminalStatus = this.terminalStatus(input.type);
      if (input.type === 'DELTA' || input.type === 'USAGE' || terminalStatus !== undefined) {
        await messageRepository.update(
          {
            ...message,
            version: message.version + 1,
            updatedAt: timestamp,
            parts,
            status: terminalStatus ?? message.status,
            ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
            ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
            ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
            ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
            ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          },
          message.version,
        );
      }
      return event;
    });
  }

  private storedPart(part: MessagePart, role: MessageRole): MessagePart {
    const promptsSetting = this.options.storePrompts;
    const responsesSetting = this.options.storeResponses;
    const toolPayloadsSetting = this.options.storeToolPayloads;
    const storePrompts =
      typeof promptsSetting === 'function' ? promptsSetting() : (promptsSetting ?? true);
    const storeResponses =
      typeof responsesSetting === 'function' ? responsesSetting() : (responsesSetting ?? true);
    const storeToolPayloads =
      typeof toolPayloadsSetting === 'function'
        ? toolPayloadsSetting()
        : (toolPayloadsSetting ?? true);
    const redactPii = this.privacySetting(this.options.redactPii);
    if ((role === 'user' || role === 'system') && !storePrompts)
      return { id: part.id, type: part.type };
    if (role === 'assistant' && !storeResponses) return { id: part.id, type: part.type };
    if (!storeToolPayloads && (part.type === 'tool_call' || part.type === 'tool_result'))
      return { id: part.id, type: part.type };
    return redactPii ? redactPiiPart(part) : part;
  }

  private storePromptsEnabled(): boolean {
    const setting = this.options.storePrompts;
    return typeof setting === 'function' ? setting() : (setting ?? true);
  }

  async replayStream(
    organizationId: string,
    messageId: string,
    afterCursor = 0,
    limit = 100,
  ): Promise<StreamReplay> {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) throw new Error('Invalid cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid limit');
    const message = await this.adapter
      .repository<Message>(messages)
      .findById(organizationId, messageId);
    if (message === undefined) throw new Error('Stream message not found');
    const matching = (
      await all(this.adapter.repository<ChatStreamEvent>(streamEvents), organizationId)
    )
      .filter((event) => event.messageId === messageId && event.sequence > afterCursor)
      .sort((left, right) => left.sequence - right.sequence);
    const events = matching.slice(0, limit);
    const last = events.at(-1);
    return {
      events,
      ...(matching.length > events.length && last !== undefined
        ? { nextCursor: last.sequence }
        : {}),
    };
  }

  async getMessage(organizationId: string, messageId: string): Promise<Message> {
    const message = await this.adapter
      .repository<Message>(messages)
      .findById(organizationId, messageId);
    if (message === undefined) throw new Error('Conversation message not found');
    return message;
  }

  async runStream<T>(
    messageId: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.activeStreams.has(messageId)) throw new Error('Stream is already active');
    const controller = new AbortController();
    this.activeStreams.set(messageId, controller);
    try {
      return await operation(controller.signal);
    } finally {
      this.activeStreams.delete(messageId);
    }
  }

  async cancelStream(input: {
    organizationId: string;
    messageId: string;
    idempotencyKey: string;
  }): Promise<ChatStreamEvent> {
    const event = await this.appendStreamEvent({
      organizationId: input.organizationId,
      messageId: input.messageId,
      type: 'CANCELLED',
      idempotencyKey: input.idempotencyKey,
    });
    this.activeStreams.get(input.messageId)?.abort();
    return event;
  }

  async history(organizationId: string, conversationId: string, branchId: string) {
    const branch = await this.adapter
      .repository<ConversationBranch>(branches)
      .findById(organizationId, branchId);
    if (branch?.conversationId !== conversationId) throw new Error('Conversation branch not found');
    const messageItems = await all(this.adapter.repository<Message>(messages), organizationId);
    const branchItems = await all(
      this.adapter.repository<ConversationBranch>(branches),
      organizationId,
    );
    const resolve = (current: ConversationBranch, visited: ReadonlySet<string>): Message[] => {
      if (visited.has(current.id)) throw new Error('Conversation branch cycle detected');
      const local = messageItems.filter((message) => message.branchId === current.id);
      if (current.parentBranchId === undefined || current.forkedFromMessageId === undefined)
        return local.sort((left, right) => left.sequence - right.sequence);
      const parent = branchItems.find((candidate) => candidate.id === current.parentBranchId);
      const source = messageItems.find(
        (message) => message.id === current.forkedFromMessageId && message.branchId === parent?.id,
      );
      if (parent === undefined || source === undefined)
        throw new Error('Branch ancestry is invalid');
      const inherited = resolve(parent, new Set([...visited, current.id])).filter(
        (message) =>
          message.sequence <= source.sequence && message.id !== current.replacesMessageId,
      );
      return [...inherited, ...local].sort((left, right) => left.sequence - right.sequence);
    };
    return resolve(branch, new Set());
  }

  /** Includes unpersisted prompt text only for in-process model execution. */
  async historyForExecution(organizationId: string, conversationId: string, branchId: string) {
    const items = await this.history(organizationId, conversationId, branchId);
    const now = this.now().getTime();
    for (const [id, prompt] of this.transientPrompts)
      if (prompt.expiresAt <= now) this.transientPrompts.delete(id);
    return items.map((message) => {
      const prompt = this.transientPrompts.get(message.id);
      return prompt?.organizationId === organizationId
        ? { ...message, parts: prompt.parts }
        : message;
    });
  }

  async historyPage(
    organizationId: string,
    conversationId: string,
    branchId: string,
    cursor?: string,
    limit = 50,
  ): Promise<ChatPage<Message>> {
    return page(await this.history(organizationId, conversationId, branchId), cursor, limit);
  }

  async listUsage(organizationId: string): Promise<readonly ChatUsageRecord[]> {
    const records = await all(this.adapter.repository<Message>(messages), organizationId);
    return records
      .filter(
        (message) =>
          message.role === 'assistant' &&
          ['COMPLETED', 'FAILED', 'CANCELLED'].includes(message.status),
      )
      .map((message) => ({
        id: message.id,
        organizationId,
        principalId: message.createdBy,
        scopeType: 'USER' as const,
        scopeKey: message.createdBy,
        ...(message.providerId === undefined ? {} : { provider: message.providerId }),
        ...(message.modelDefinitionId === undefined ? {} : { model: message.modelDefinitionId }),
        inputTokens: message.inputTokens ?? 0,
        outputTokens: message.outputTokens ?? 0,
        costUsd: message.costUsd ?? 0,
        ...(message.latencyMs === undefined ? {} : { latencyMs: message.latencyMs }),
        outcome: message.status === 'COMPLETED' ? ('SUCCESS' as const) : ('ERROR' as const),
      }));
  }

  private async requireMessage(organizationId: string, conversationId: string, messageId: string) {
    const message = await this.adapter
      .repository<Message>(messages)
      .findById(organizationId, messageId);
    if (message?.conversationId !== conversationId)
      throw new Error('Conversation message not found');
    return message;
  }

  private async requireConversationWriter(
    organizationId: string,
    conversationId: string,
    principalId: string,
  ) {
    await this.requireParticipant(organizationId, conversationId, principalId, true);
    const conversation = await this.adapter
      .repository<Conversation>(conversations)
      .findById(organizationId, conversationId);
    if (conversation === undefined) throw new Error('Conversation not found');
    return conversation;
  }

  private async validatePartReferences(
    context: Parameters<Parameters<DatabaseAdapter['run']>[0]>[0],
    organizationId: string,
    conversationId: string,
    parts: readonly MessagePart[],
  ) {
    for (const part of parts) {
      if (['image', 'audio', 'file'].includes(part.type)) {
        const attachmentId = part.uri?.match(/^attachment:\/\/([0-9a-z-]+)$/i)?.[1];
        const attachment =
          attachmentId === undefined
            ? undefined
            : await context
                .repository<Attachment>(attachments)
                .findById(organizationId, attachmentId);
        if (attachment?.conversationId !== conversationId || attachment.status !== 'READY')
          throw new Error('Message attachment reference is invalid');
      }
      if (part.type === 'citation')
        await this.requirePartEntity(
          context.repository<Citation>(citations),
          organizationId,
          conversationId,
          part.data?.citationId,
          'citation',
        );
      if (part.type === 'artifact')
        await this.requirePartEntity(
          context.repository<Artifact>(artifacts),
          organizationId,
          conversationId,
          part.data?.artifactId,
          'artifact',
        );
    }
  }

  private async requirePartEntity<T extends TenantEntity & { readonly conversationId: string }>(
    repository: Repository<T>,
    organizationId: string,
    conversationId: string,
    reference: unknown,
    kind: string,
  ) {
    const entity =
      typeof reference === 'string'
        ? await repository.findById(organizationId, reference)
        : undefined;
    if (entity?.conversationId !== conversationId)
      throw new Error(`Message ${kind} reference is invalid`);
  }

  private validateAttachment(filename: string, mimeType: string, sizeBytes: number) {
    const maximum = this.options.maxAttachmentBytes ?? 25 * 1024 * 1024;
    if (sizeBytes < 1 || sizeBytes > maximum) throw new Error('Attachment size is invalid');
    let hasControlCharacter = false;
    for (let index = 0; index < filename.length; index += 1) {
      if (filename.charCodeAt(index) < 32) hasControlCharacter = true;
    }
    if (
      filename.length > 255 ||
      filename.includes('/') ||
      filename.includes('\\') ||
      hasControlCharacter
    )
      throw new Error('Attachment filename is invalid');
    const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    const allowed: Readonly<Record<string, readonly string[]>> = {
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/webp': ['.webp'],
      'audio/mpeg': ['.mp3'],
      'audio/wav': ['.wav'],
      'application/pdf': ['.pdf'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md'],
    };
    if (!allowed[mimeType]?.includes(extension))
      throw new Error('Attachment MIME type and extension are not allowed');
  }

  private async createReplacementBranch(input: {
    organizationId: string;
    conversationId: string;
    source: Message;
    name: string;
    createdBy: string;
  }) {
    const branch = await this.createBranch({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      fromMessageId: input.source.id,
      name: input.name,
      createdBy: input.createdBy,
    });
    return this.adapter.repository<ConversationBranch>(branches).update(
      {
        ...branch,
        version: branch.version + 1,
        updatedAt: this.now(),
        replacesMessageId: input.source.id,
      },
      branch.version,
    );
  }

  private async changeConversationStatus(
    input: { organizationId: string; conversationId: string; actorId: string },
    status: Exclude<ConversationStatus, 'DELETED'>,
    operation: ChatAuditOperation,
  ): Promise<Conversation> {
    return this.adapter.run(async (context) => {
      const repository = context.repository<Conversation>(conversations);
      const conversation = await repository.findById(input.organizationId, input.conversationId);
      if (conversation === undefined || conversation.status === 'DELETED')
        throw new Error('Conversation not found');
      await this.requireOwner(
        context.repository<ConversationParticipant>(participants),
        input.organizationId,
        input.conversationId,
        input.actorId,
      );
      if (conversation.status === status) return conversation;
      if (status === 'ARCHIVED' && conversation.status !== 'ACTIVE')
        throw new Error('Only active conversations can be archived');
      if (status === 'ACTIVE' && conversation.status !== 'ARCHIVED')
        throw new Error('Only archived conversations can be restored');
      const timestamp = this.now();
      const updated = await repository.update(
        {
          ...conversation,
          version: conversation.version + 1,
          updatedAt: timestamp,
          status,
        },
        conversation.version,
      );
      await this.insertAudit(context.repository<ChatAuditEvent>(auditEvents), {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        actorId: input.actorId,
        operation,
        timestamp,
      });
      return updated;
    });
  }

  private async requireOwner(
    repository: Repository<ConversationParticipant>,
    organizationId: string,
    conversationId: string,
    actorId: string,
  ) {
    const owner = (await all(repository, organizationId)).find(
      (participant) =>
        participant.conversationId === conversationId &&
        participant.principalId === actorId &&
        participant.role === 'OWNER',
    );
    if (owner === undefined) throw new Error('Conversation owner permission is required');
  }

  private async insertAudit(
    repository: Repository<ChatAuditEvent>,
    input: {
      organizationId: string;
      conversationId: string;
      actorId: string;
      operation: ChatAuditOperation;
      timestamp: Date;
    },
  ) {
    await repository.insert({
      id: uuidV7(input.timestamp.getTime()),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      version: 1,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
      operation: input.operation,
      conversationId: input.conversationId,
      actorId: input.actorId,
      outcome: 'SUCCEEDED',
    });
  }

  private async reviseAssistant(
    input: {
      organizationId: string;
      conversationId: string;
      createdBy: string;
      modelDefinitionId?: string;
      providerId?: string;
    },
    source: Message,
    operation: 'regenerate' | 'retry',
  ) {
    const branch = await this.createReplacementBranch({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      source,
      name: `${operation}-${String(source.sequence)}`,
      createdBy: input.createdBy,
    });
    const message = await this.appendMessage({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      branchId: branch.id,
      role: 'assistant',
      parts: [{ id: uuidV7(this.now().getTime()), type: 'text', text: '' }],
      status: 'PENDING',
      createdBy: input.createdBy,
      ...(source.parentMessageId === undefined ? {} : { parentMessageId: source.parentMessageId }),
      ...((input.modelDefinitionId ?? source.modelDefinitionId) === undefined
        ? {}
        : { modelDefinitionId: input.modelDefinitionId ?? source.modelDefinitionId }),
      ...((input.providerId ?? source.providerId) === undefined
        ? {}
        : { providerId: input.providerId ?? source.providerId }),
    });
    return { branch, message };
  }

  private assertIdempotencyKey(value: string) {
    if (value.trim() === '' || value.length > 128) throw new Error('Invalid idempotency key');
  }

  private validateStreamEvent(input: {
    type: ChatStreamEventType;
    part?: MessagePart;
    errorCode?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    finishReason?: ChatStreamEvent['finishReason'];
    latencyMs?: number;
  }) {
    const { type, part, errorCode } = input;
    if ((type === 'DELTA') !== (part !== undefined))
      throw new Error('Only delta stream events require a message part');
    if (part !== undefined && JSON.stringify(part).length > 65_536)
      throw new Error('Stream event exceeds the maximum payload size');
    if ((type === 'FAILED') !== (errorCode !== undefined))
      throw new Error('Only failed stream events require an error code');
    if (errorCode !== undefined && !/^[A-Z][A-Z0-9_]{1,63}$/.test(errorCode))
      throw new Error('Invalid stream error code');
    const hasUsage =
      input.inputTokens !== undefined ||
      input.outputTokens !== undefined ||
      input.costUsd !== undefined;
    if ((type === 'USAGE') !== hasUsage)
      throw new Error('Only usage stream events require usage metadata');
    if (
      type === 'USAGE' &&
      (!Number.isSafeInteger(input.inputTokens) ||
        !Number.isSafeInteger(input.outputTokens) ||
        (input.inputTokens ?? -1) < 0 ||
        (input.outputTokens ?? -1) < 0 ||
        !Number.isFinite(input.costUsd) ||
        (input.costUsd ?? -1) < 0)
    )
      throw new Error('Stream usage metadata is invalid');
    if (type !== 'COMPLETED' && input.finishReason !== undefined)
      throw new Error('Only completed stream events require a finish reason');
    if (input.latencyMs !== undefined && (!Number.isFinite(input.latencyMs) || input.latencyMs < 0))
      throw new Error('Stream latency is invalid');
  }

  private terminalStatus(type: ChatStreamEventType): MessageStatus | undefined {
    if (type === 'COMPLETED') return 'COMPLETED';
    if (type === 'FAILED') return 'FAILED';
    if (type === 'CANCELLED') return 'CANCELLED';
    return undefined;
  }
}

export * from './execution.js';
