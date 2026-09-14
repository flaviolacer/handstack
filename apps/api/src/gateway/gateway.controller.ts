import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { GatewayRuntimeService } from './gateway-runtime.service.js';
import { IdentityAdministrationService } from '@handstack/identity-service';

const issueSchema = z.object({
  ownerId: z.string().trim().min(1),
  ownerType: z.enum(['USER', 'APPLICATION', 'SERVICE_ACCOUNT']),
  name: z.string().trim().min(1).max(120),
  environment: z.enum(['live', 'test']),
  permissions: z.array(z.string().trim().min(1)).min(1),
  models: z.array(z.string().trim().min(1)).optional(),
  budgetUsd: z.number().nonnegative().optional(),
  requestsPerMinute: z.number().int().min(1).max(100_000).optional(),
  expiresAt: z.coerce.date().optional(),
});

@ApiTags('Gateway API keys')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/gateway/keys')
@UseGuards(AccessTokenGuard)
export class GatewayController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(GatewayRuntimeService) private readonly runtime: GatewayRuntimeService,
    @Inject(AuthRuntimeService) private readonly auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  @ApiOperation({ summary: 'List virtual API keys without secrets' })
  async list(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const page = await this.runtime.list(organizationId);
    return { ...page, items: page.items.map((key) => GatewayRuntimeService.publicKey(key)) };
  }

  @Post()
  @ApiOperation({ summary: 'Issue a virtual API key; secret is returned once' })
  @ApiBody({ schema: { type: 'object' } })
  @ApiCreatedResponse({ description: 'The secret is returned only in this response' })
  async issue(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const parsed = issueSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid key');
    const input = parsed.data;
    const issued = await this.runtime.issue({
      organizationId,
      ownerId: input.ownerId,
      ownerType: input.ownerType,
      name: input.name,
      environment: input.environment,
      permissions: input.permissions,
      ...(input.models === undefined ? {} : { models: input.models }),
      ...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd }),
      ...(input.requestsPerMinute === undefined
        ? {}
        : { requestsPerMinute: input.requestsPerMinute }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    return { key: GatewayRuntimeService.publicKey(issued.key), secret: issued.secret };
  }

  @Post(':keyId/revoke')
  @ApiOperation({ summary: 'Revoke a virtual API key' })
  async revoke(
    @Param('organizationId') organizationId: string,
    @Param('keyId') keyId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    await this.runtime.revoke(organizationId, keyId);
    return { revoked: true, id: keyId };
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest): Promise<void> {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId) {
      throw new AuthorizationError('Cross-organization gateway administration is forbidden');
    }
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'api-key.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('api-key.manage permission is required');
  }
}
