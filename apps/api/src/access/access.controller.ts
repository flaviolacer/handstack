import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { AccessRuntimeService } from './access-runtime.service.js';

const requestSchema = z.object({
  resource: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(4_000),
  duration: z.enum(['1h', '4h', '24h', '7d', 'permanent']),
  reference: z.string().trim().max(200).optional(),
});
const approverSchema = z.object({ approverId: z.string().trim().min(1).max(200) });

@ApiTags('Access governance')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/access-requests')
@UseGuards(AccessTokenGuard)
export class AccessController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(AccessRuntimeService) private readonly runtime: AccessRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  @ApiOperation({ summary: 'List access requests' })
  async list(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'access.read');
    return { items: await this.runtime.access.list(organizationId) };
  }

  @Post()
  @ApiOperation({ summary: 'Submit an access request' })
  async submit(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const auth = await this.authorize(organizationId, request, 'access.request');
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid access request');
    return await this.runtime.access.submit({
      organizationId,
      requesterId: auth.subject,
      resource: parsed.data.resource,
      reason: parsed.data.reason,
      duration: parsed.data.duration,
      ...(parsed.data.reference === undefined ? {} : { reference: parsed.data.reference }),
    });
  }

  @Get('grants')
  @ApiOperation({ summary: 'List active and revoked access grants' })
  async grants(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'access.read');
    return { items: await this.runtime.access.listGrants(organizationId) };
  }

  @Post(':requestId/approve')
  @ApiOperation({ summary: 'Approve an access request' })
  async approve(
    @Param('organizationId') organizationId: string,
    @Param('requestId') requestId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const auth = await this.authorize(organizationId, request, 'access.approve');
    const parsed = approverSchema.safeParse(value);
    if (!parsed.success || parsed.data.approverId !== auth.subject)
      throw new AuthorizationError('Approver must match authenticated principal');
    return await this.runtime.access.approve(organizationId, requestId, auth.subject);
  }

  @Post(':requestId/grants/:grantId/revoke')
  @ApiOperation({ summary: 'Revoke an access grant' })
  async revoke(
    @Param('organizationId') organizationId: string,
    @Param('requestId') requestId: string,
    @Param('grantId') grantId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'access.approve');
    return await this.runtime.access.revoke(organizationId, grantId, requestId);
  }

  private async authorize(
    organizationId: string,
    request: AuthenticatedRequest,
    permission: string,
  ) {
    const auth = requireAuthentication(request);
    if (auth.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization access governance is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: auth.subject,
      permission,
    });
    if (!decision.allowed) throw new AuthorizationError(`${permission} permission is required`);
    return auth;
  }
}
