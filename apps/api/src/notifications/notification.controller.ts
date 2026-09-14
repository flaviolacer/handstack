import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { NotificationRuntimeService } from './notification-runtime.service.js';

const sendSchema = z.object({
  id: z.string().trim().min(1).max(200),
  recipientId: z.string().trim().min(1).max(200),
  channel: z.literal('IN_APP'),
  subject: z.string().max(500),
  body: z.string().max(1_000_000),
  metadata: z.record(z.string(), z.string()).optional(),
});

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/notifications')
@UseGuards(AccessTokenGuard)
export class NotificationController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(NotificationRuntimeService) private readonly runtime: NotificationRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get(':recipientId')
  @ApiOperation({ summary: 'List tenant in-app notifications for a recipient' })
  async list(
    @Param('organizationId') organizationId: string,
    @Param('recipientId') recipientId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'notifications.read');
    return { items: await this.runtime.list(organizationId, recipientId) };
  }

  @Post()
  @ApiOperation({ summary: 'Send a tenant in-app notification' })
  async send(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'notifications.send');
    const parsed = sendSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid notification');
    const { metadata, ...content } = parsed.data;
    await this.runtime.send({
      organizationId,
      createdAt: new Date(),
      ...content,
      ...(metadata === undefined ? {} : { metadata }),
    });
    return { id: parsed.data.id, organizationId, queued: true };
  }

  private async authorize(
    organizationId: string,
    request: AuthenticatedRequest,
    permission: string,
  ): Promise<void> {
    const auth = requireAuthentication(request);
    if (auth.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization notification access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: auth.subject,
      permission,
    });
    if (!decision.allowed) throw new AuthorizationError(`${permission} permission is required`);
  }
}
