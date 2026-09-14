import { AuthorizationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { CapabilityRuntimeService } from './capability-runtime.service.js';
import { IdentityAdministrationService } from '@handstack/identity-service';

@ApiTags('Capabilities')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/capabilities')
@UseGuards(AccessTokenGuard)
export class CapabilityController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(CapabilityRuntimeService) private readonly runtime: CapabilityRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  @ApiOperation({ summary: 'List capabilities available on the API channel' })
  async list(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const principal = await this.authorize(organizationId, request);
    return {
      items: await this.runtime.registry.list(organizationId, 'API'),
      principalId: principal,
    };
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Resolve an API capability' })
  async get(
    @Param('organizationId') organizationId: string,
    @Param('slug') slug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const entry = await this.runtime.registry.get(organizationId, slug);
    if (entry === undefined) throw new AuthorizationError('Capability is unavailable');
    if (!entry.capability.allowedChannels.includes('API'))
      throw new AuthorizationError('Capability is unavailable');
    return entry.capability;
  }

  @Post(':slug/run')
  @ApiOperation({ summary: 'Execute a capability through the governed engine' })
  async run(
    @Param('organizationId') organizationId: string,
    @Param('slug') slug: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const principalId = await this.authorize(organizationId, request);
    return this.runtime.engine.execute(slug, body, { organizationId, principalId, channel: 'API' });
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest): Promise<string> {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization capability access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'capability.execute',
    });
    if (!decision.allowed)
      throw new AuthorizationError('capability.execute permission is required');
    return authentication.subject;
  }
}
