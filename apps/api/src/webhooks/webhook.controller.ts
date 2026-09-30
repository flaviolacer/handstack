import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  requestTraceContext,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { WebhookRuntimeService } from './webhook-runtime.service.js';

const configurationSchema = z.object({
  endpoint: z.url().max(2_000),
  secret: z.string().min(16).max(512),
  source: z.string().trim().min(1).max(100).optional(),
});
const dispatchSchema = z.object({
  id: z.string().trim().min(1).max(200),
  event: z.enum([
    'agent.completed',
    'budget.threshold',
    'access.requested',
    'access.approved',
    'plugin.installed',
    'user.created',
  ]),
  payload: z.unknown(),
});
const rotationSchema = z.object({
  secret: z.string().min(16).max(512),
  keyId: z.string().trim().min(1).max(200).optional(),
  overlapMs: z.number().int().min(0).max(86_400_000).optional(),
});
const deliveryQuerySchema = z.object({
  status: z.enum(['PENDING', 'DELIVERED', 'RETRYING', 'DEAD_LETTERED']).optional(),
});

@ApiTags('Webhooks')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/webhooks')
@UseGuards(AccessTokenGuard)
export class WebhookController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(WebhookRuntimeService) private readonly runtime: WebhookRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Post('configuration')
  @ApiOperation({ summary: 'Configure the tenant webhook endpoint' })
  configure(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    return this.authorize(organizationId, request).then(async () => {
      const parsed = configurationSchema.safeParse(value);
      if (!parsed.success)
        throw new ValidationError(
          parsed.error.issues[0]?.message ?? 'Invalid webhook configuration',
        );
      await this.runtime.configure(
        organizationId,
        parsed.data.endpoint,
        parsed.data.secret,
        parsed.data.source,
      );
      return { organizationId, endpoint: parsed.data.endpoint, configured: true };
    });
  }

  @Post('deliveries')
  @ApiOperation({ summary: 'Dispatch a signed tenant webhook' })
  dispatch(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    return this.authorize(organizationId, request).then(async () => {
      const parsed = dispatchSchema.safeParse(value);
      if (!parsed.success)
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid webhook delivery');
      const auth = requireAuthentication(request);
      const trace = requestTraceContext(request);
      return await this.runtime.dispatch({
        organizationId,
        ...parsed.data,
        context: {
          requestId: trace.requestId,
          traceId: trace.traceId,
          principalId: auth.subject,
          source: 'API',
        },
      });
    });
  }

  @Post('configuration/rotate-secret')
  @ApiOperation({ summary: 'Rotate a tenant webhook secret with overlap' })
  rotateSecret(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    return this.authorize(organizationId, request).then(async () => {
      const parsed = rotationSchema.safeParse(value);
      if (!parsed.success)
        throw new ValidationError(
          parsed.error.issues[0]?.message ?? 'Invalid webhook secret rotation',
        );
      return await this.runtime.rotateSecret(
        organizationId,
        parsed.data.secret,
        parsed.data.keyId,
        parsed.data.overlapMs,
      );
    });
  }

  @Get('dead-letters')
  @ApiOperation({ summary: 'Inspect tenant webhook dead letters' })
  deadLetters(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.authorize(organizationId, request).then(async () => ({
      items: await this.runtime.deadLetters(organizationId),
    }));
  }

  @Get('deliveries')
  @ApiOperation({ summary: 'List tenant webhook deliveries' })
  deliveries(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Query('status') status?: string,
  ) {
    return this.authorize(organizationId, request).then(async () => {
      const parsed = deliveryQuerySchema.safeParse({ ...(status === undefined ? {} : { status }) });
      if (!parsed.success)
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid delivery status');
      return { items: await this.runtime.deliveries(organizationId, parsed.data.status) };
    });
  }

  @Post('dead-letters/:deliveryId/replay')
  @ApiOperation({ summary: 'Replay a tenant webhook dead letter' })
  replay(
    @Param('organizationId') organizationId: string,
    @Param('deliveryId') deliveryId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.authorize(organizationId, request).then(
      async () => await this.runtime.replay(organizationId, deliveryId),
    );
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest): Promise<void> {
    const auth = requireAuthentication(request);
    if (auth.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization webhook access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: auth.subject,
      permission: 'webhooks.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('webhooks.manage permission is required');
  }
}
