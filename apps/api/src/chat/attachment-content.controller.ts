import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ChatRuntimeService } from './chat-runtime.service.js';
import { attachmentDownloadQuerySchema } from './chat.schemas.js';

@ApiTags('Chat attachments')
@Controller('api/v1/attachments')
export class AttachmentContentController {
  constructor(@Inject(ChatRuntimeService) private readonly runtime: ChatRuntimeService) {}

  @Get('content')
  @ApiOperation({ summary: 'Download content using a short-lived signed token' })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: 'Attachment bytes' })
  async content(@Query() query: unknown, @Res() reply: FastifyReply) {
    const parsed = attachmentDownloadQuerySchema.safeParse(query);
    if (!parsed.success) throw new ValidationError('Attachment token is invalid');
    try {
      const content = await this.runtime.attachmentStorage.readSigned(parsed.data.token);
      return await reply
        .header('cache-control', 'private, no-store')
        .header('content-type', 'application/octet-stream')
        .send(Buffer.from(content));
    } catch {
      throw new AuthorizationError('Attachment token is invalid or expired');
    }
  }
}
