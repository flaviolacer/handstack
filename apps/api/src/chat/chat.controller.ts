import type { MessagePart } from '@handstack/chat';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { AuthorizationError, ValidationError } from '@handstack/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiAcceptedResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
  type SchemaObject,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { ChatRuntimeService } from './chat-runtime.service.js';
import { ChatRateLimitService } from './chat-rate-limit.service.js';
import {
  appendMessageSchema,
  attachmentUploadQuerySchema,
  attachmentUrlQuerySchema,
  chatPageQuerySchema,
  createConversationSchema,
  editMessageSchema,
  executeChatSchema,
  regenerateMessageSchema,
} from './chat.schemas.js';

function schema(value: z.ZodType): SchemaObject {
  return z.toJSONSchema(value, { target: 'draft-7' }) as SchemaObject;
}

function parse<T>(definition: z.ZodType<T>, value: unknown): T {
  const result = definition.safeParse(value);
  if (!result.success)
    throw new ValidationError(result.error.issues[0]?.message ?? 'Request validation failed');
  return result.data;
}

function messageParts(parts: z.infer<typeof appendMessageSchema>['parts']): MessagePart[] {
  return parts.map((part) => ({
    id: part.id,
    type: part.type,
    ...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
    ...(part.text === undefined ? {} : { text: part.text }),
    ...(part.uri === undefined ? {} : { uri: part.uri }),
    ...(part.data === undefined ? {} : { data: part.data }),
  }));
}

@ApiTags('Chat')
@ApiBearerAuth()
@ApiParam({ name: 'organizationId', description: 'Organization scope' })
@ApiUnauthorizedResponse({ description: 'Bearer access token is missing or invalid' })
@ApiForbiddenResponse({ description: 'Organization mismatch or chat.use is missing' })
@Controller('api/v1/organizations/:organizationId')
@UseGuards(AccessTokenGuard)
export class ChatController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
    @Inject(ChatRuntimeService) private readonly runtime: ChatRuntimeService,
    @Inject(ChatRateLimitService) private readonly rateLimit: ChatRateLimitService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get('chat/models')
  @ApiOperation({ summary: 'List published models available to chat users' })
  @ApiOkResponse({ description: 'Public chat model catalog without provider secrets' })
  async models(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.listPublishedModels(organizationId);
  }

  @Get('chat/agents')
  @ApiOperation({ summary: 'List published agents available to the chat workspace' })
  @ApiOkResponse({ description: 'Published WEB agents without implementation details' })
  async agents(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.listPublishedAgents(organizationId);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'List conversations visible to the principal' })
  @ApiOkResponse({ description: 'Visible conversations' })
  async list(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ) {
    const subject = await this.authorize(organizationId, request);
    const input = parse(chatPageQuerySchema, query);
    return this.runtime.chat.listConversationsPage(
      organizationId,
      subject,
      input.cursor,
      input.limit,
    );
  }

  @Post('conversations')
  @ApiOperation({ summary: 'Create a conversation' })
  @ApiBody({ schema: schema(createConversationSchema) })
  @ApiCreatedResponse({ description: 'Conversation created' })
  async create(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const subject = await this.authorize(organizationId, request);
    const input = parse(createConversationSchema, value);
    return this.runtime.chat.createConversation({
      organizationId,
      createdBy: subject,
      title: input.title,
    });
  }

  @Patch('conversations/:conversationId/archive')
  @ApiOperation({ summary: 'Archive an owned conversation' })
  @ApiOkResponse({ description: 'Conversation archived' })
  async archive(
    @Param('organizationId') organizationId: string,
    @Param('conversationId') conversationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const actorId = await this.authorize(organizationId, request);
    return this.runtime.chat.archiveConversation({ organizationId, conversationId, actorId });
  }

  @Patch('conversations/:conversationId/restore')
  @ApiOperation({ summary: 'Restore an archived conversation' })
  @ApiOkResponse({ description: 'Conversation restored' })
  async restore(
    @Param('organizationId') organizationId: string,
    @Param('conversationId') conversationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const actorId = await this.authorize(organizationId, request);
    return this.runtime.chat.restoreConversation({ organizationId, conversationId, actorId });
  }

  @Delete('conversations/:conversationId')
  @ApiOperation({ summary: 'Delete conversation content and retain audit evidence' })
  @ApiOkResponse({ description: 'Redacted conversation tombstone' })
  async removeConversation(
    @Param('organizationId') organizationId: string,
    @Param('conversationId') conversationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const actorId = await this.authorize(organizationId, request);
    return this.runtime.chat.deleteConversation({ organizationId, conversationId, actorId });
  }

  @Get('conversations/:conversationId/branches/:branchId/messages')
  @ApiOperation({ summary: 'Read ordered branch history' })
  @ApiOkResponse({ description: 'Ordered multimodal messages' })
  async history(
    @Param('organizationId') organizationId: string,
    @Param('conversationId') conversationId: string,
    @Param('branchId') branchId: string,
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ) {
    const subject = await this.authorize(organizationId, request);
    await this.runtime.chat.requireParticipant(organizationId, conversationId, subject);
    const input = parse(chatPageQuerySchema, query);
    return this.runtime.chat.historyPage(
      organizationId,
      conversationId,
      branchId,
      input.cursor,
      input.limit,
    );
  }

  @Post('conversations/:conversationId/branches/:branchId/messages')
  @ApiOperation({ summary: 'Append a multimodal message' })
  @ApiBody({ schema: schema(appendMessageSchema) })
  @ApiCreatedResponse({ description: 'Message appended' })
  async append(
    @Param('organizationId') organizationId: string,
    @Param('conversationId') conversationId: string,
    @Param('branchId') branchId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const subject = await this.authorize(organizationId, request);
    const input = parse(appendMessageSchema, value);
    return this.runtime.chat.appendMessage({
      organizationId,
      conversationId,
      branchId,
      role: input.role,
      parts: messageParts(input.parts),
      createdBy: subject,
      ...(input.parentMessageId === undefined ? {} : { parentMessageId: input.parentMessageId }),
    });
  }

  @Post('conversations/:conversationId/attachments')
  @ApiOperation({ summary: 'Upload and scan a conversation attachment' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({ description: 'Scanned attachment metadata' })
  async uploadAttachment(
    @Param('organizationId') organizationId: string,
    @Param('conversationId') conversationId: string,
    @Req() request: AuthenticatedRequest & FastifyRequest,
    @Query() query: unknown,
  ) {
    const subject = await this.authorize(organizationId, request);
    const input = parse(attachmentUploadQuerySchema, query);
    try {
      const file = await request.file();
      if (file === undefined) throw new ValidationError('A multipart file is required');
      const content = await file.toBuffer();
      return await this.runtime.chat.storeAttachment({
        organizationId,
        conversationId,
        createdBy: subject,
        filename: file.filename,
        mimeType: file.mimetype,
        content,
        dataClassification: input.dataClassification,
      });
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError(
        error instanceof Error ? error.message : 'Attachment upload failed',
      );
    }
  }

  @Get('conversations/:conversationId/attachments/:attachmentId/url')
  @ApiOperation({ summary: 'Create a short-lived signed attachment URL' })
  @ApiOkResponse({ description: 'Relative signed download URL and expiration lifetime' })
  async attachmentUrl(
    @Param('organizationId') organizationId: string,
    @Param('conversationId') conversationId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ) {
    const subject = await this.authorize(organizationId, request);
    await this.runtime.chat.requireParticipant(organizationId, conversationId, subject);
    const attachment = await this.runtime.chat.getAttachment(organizationId, attachmentId);
    if (attachment.conversationId !== conversationId) throw new AuthorizationError('Forbidden');
    const input = parse(attachmentUrlQuerySchema, query);
    return {
      url: await this.runtime.chat.attachmentUrl(
        organizationId,
        attachmentId,
        input.expiresInSeconds,
      ),
      expiresInSeconds: input.expiresInSeconds,
    };
  }

  @Delete('conversations/:conversationId/attachments/:attachmentId')
  @ApiOperation({ summary: 'Delete attachment content and tombstone its metadata' })
  @ApiNoContentResponse({ description: 'Attachment deleted' })
  @HttpCode(204)
  async deleteAttachment(
    @Param('organizationId') organizationId: string,
    @Param('conversationId') conversationId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const subject = await this.authorize(organizationId, request);
    await this.runtime.chat.deleteAttachment({
      organizationId,
      conversationId,
      attachmentId,
      deletedBy: subject,
    });
  }

  @Post('conversations/:conversationId/branches/:branchId/executions')
  @ApiOperation({ summary: 'Execute the selected model and durably stream its response' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: schema(executeChatSchema) })
  @ApiAcceptedResponse({ description: 'Streaming assistant message; consume its SSE event URL' })
  @HttpCode(202)
  async execute(
    @Param('organizationId') organizationId: string,
    @Param('conversationId') conversationId: string,
    @Param('branchId') branchId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const subject = await this.authorize(organizationId, request);
    if (idempotencyKey === undefined || idempotencyKey.trim() === '')
      throw new ValidationError('Idempotency-Key is required');
    const input = parse(executeChatSchema, value);
    await this.rateLimit.consume(organizationId);
    return this.runtime.startExecution({
      organizationId,
      conversationId,
      branchId,
      createdBy: subject,
      model: input.model,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      dataClassification: input.dataClassification,
      idempotencyKey,
      ...(input.parentMessageId === undefined ? {} : { parentMessageId: input.parentMessageId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      ...(input.knowledgeBaseId === undefined ? {} : { knowledgeBaseId: input.knowledgeBaseId }),
    });
  }

  @Post('conversations/:conversationId/messages/:messageId/edit')
  @ApiOperation({ summary: 'Edit a user message on a replacement branch' })
  @ApiBody({ schema: schema(editMessageSchema) })
  async edit(
    @Param('organizationId') organizationId: string,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const subject = await this.authorize(organizationId, request);
    return this.runtime.chat.editMessage({
      organizationId,
      conversationId,
      messageId,
      createdBy: subject,
      parts: messageParts(parse(editMessageSchema, value).parts),
    });
  }

  @Post('conversations/:conversationId/messages/:messageId/regenerate')
  @ApiOperation({ summary: 'Regenerate an assistant message on a replacement branch' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: schema(regenerateMessageSchema) })
  async regenerate(
    @Param('organizationId') organizationId: string,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const subject = await this.authorize(organizationId, request);
    if (idempotencyKey === undefined || idempotencyKey.trim() === '')
      throw new ValidationError('Idempotency-Key is required');
    const input = parse(regenerateMessageSchema, value);
    const revision = await this.runtime.chat.regenerateMessage({
      organizationId,
      conversationId,
      messageId,
      createdBy: subject,
      ...(input.model === undefined ? {} : { modelDefinitionId: input.model }),
    });
    const model = input.model ?? revision.message.modelDefinitionId;
    if (model === undefined) throw new ValidationError('A model is required for regeneration');
    const message = await this.runtime.startRevision({
      organizationId,
      conversationId,
      branchId: revision.branch.id,
      message: revision.message,
      createdBy: subject,
      model,
      dataClassification: input.dataClassification,
      idempotencyKey,
    });
    return { branch: revision.branch, message };
  }

  @Post('conversations/:conversationId/messages/:messageId/retry')
  @ApiOperation({ summary: 'Retry a failed or cancelled assistant message' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: schema(regenerateMessageSchema) })
  async retry(
    @Param('organizationId') organizationId: string,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const subject = await this.authorize(organizationId, request);
    if (idempotencyKey === undefined || idempotencyKey.trim() === '')
      throw new ValidationError('Idempotency-Key is required');
    const input = parse(regenerateMessageSchema, value);
    const revision = await this.runtime.chat.retryMessage({
      organizationId,
      conversationId,
      messageId,
      createdBy: subject,
    });
    const model = input.model ?? revision.message.modelDefinitionId;
    if (model === undefined) throw new ValidationError('A model is required for retry');
    const message = await this.runtime.startRevision({
      organizationId,
      conversationId,
      branchId: revision.branch.id,
      message: revision.message,
      createdBy: subject,
      model,
      dataClassification: input.dataClassification,
      idempotencyKey,
    });
    return { branch: revision.branch, message };
  }

  @Post('messages/:messageId/cancel')
  @ApiOperation({ summary: 'Cancel an active model stream' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async cancel(
    @Param('organizationId') organizationId: string,
    @Param('messageId') messageId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const subject = await this.authorize(organizationId, request);
    const message = await this.runtime.chat.getMessage(organizationId, messageId);
    await this.runtime.chat.requireParticipant(organizationId, message.conversationId, subject);
    if (idempotencyKey === undefined || idempotencyKey.trim() === '')
      throw new ValidationError('Idempotency-Key is required');
    return this.runtime.chat.cancelStream({ organizationId, messageId, idempotencyKey });
  }

  @Get('messages/:messageId/events')
  @ApiOperation({ summary: 'Replay and follow committed message events as SSE' })
  @ApiProduces('text/event-stream')
  @ApiHeader({ name: 'Last-Event-ID', required: false })
  async events(
    @Param('organizationId') organizationId: string,
    @Param('messageId') messageId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const subject = await this.authorize(organizationId, request);
    const message = await this.runtime.chat.getMessage(organizationId, messageId);
    await this.runtime.chat.requireParticipant(organizationId, message.conversationId, subject);
    const cursor = lastEventId === undefined ? 0 : Number(lastEventId);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new ValidationError('Last-Event-ID is invalid');
    reply.hijack();
    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache, no-transform');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.setHeader('x-accel-buffering', 'no');
    reply.raw.writeHead(200);

    let nextCursor = cursor;
    let lastWrite = Date.now();
    while (!request.raw.destroyed && !reply.raw.destroyed) {
      const replay = await this.runtime.chat.replayStream(
        organizationId,
        messageId,
        nextCursor,
        100,
      );
      for (const event of replay.events) {
        const chunk = `id: ${String(event.sequence)}\nevent: ${event.type.toLowerCase()}\ndata: ${JSON.stringify(event)}\n\n`;
        if (!reply.raw.write(chunk)) await once(reply.raw, 'drain');
        nextCursor = event.sequence;
        lastWrite = Date.now();
      }
      const current = await this.runtime.chat.getMessage(organizationId, messageId);
      const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status);
      if (terminal && replay.nextCursor === undefined) break;
      if (Date.now() - lastWrite >= 15_000) {
        if (!reply.raw.write(': heartbeat\n\n')) await once(reply.raw, 'drain');
        lastWrite = Date.now();
      }
      await delay(100);
    }
    if (!reply.raw.destroyed) reply.raw.end();
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest) {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization chat access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'chat.use',
    });
    if (!decision.allowed) throw new AuthorizationError('chat.use permission is required');
    return authentication.subject;
  }
}
