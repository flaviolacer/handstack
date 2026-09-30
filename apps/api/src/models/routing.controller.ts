import { validateRoutingPolicy, type RoutingStrategy } from '@handstack/model-routing';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { RoutingRuntimeService } from './routing-runtime.service.js';

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ValidationError('Request body must be an object');
  return value as Record<string, unknown>;
}

@ApiTags('Model routing')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/routing-policies')
@UseGuards(AccessTokenGuard)
export class RoutingController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(RoutingRuntimeService) private readonly runtime: RoutingRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  @ApiOperation({ summary: 'List tenant model routing policies' })
  async list(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.list(organizationId) };
  }

  @Post()
  @ApiOperation({ summary: 'Create a tenant model routing policy' })
  async create(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    const name = body.name;
    const strategy = body.strategy;
    const candidates = body.candidates;
    if (
      typeof name !== 'string' ||
      name.trim() === '' ||
      typeof strategy !== 'string' ||
      !Array.isArray(candidates)
    )
      throw new ValidationError('name, strategy and candidates are required');
    if (
      ![
        'fallback',
        'round_robin',
        'least_cost',
        'least_latency',
        'weighted',
        'priority',
        'random',
        'custom',
        'semantic',
      ].includes(strategy)
    )
      throw new ValidationError('strategy is invalid');
    if (
      !candidates.every(
        (candidate) =>
          typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate),
      )
    )
      throw new ValidationError('candidates must be objects');
    const policy = await this.runtime.create(organizationId, {
      name: name.trim(),
      strategy: strategy as RoutingStrategy,
      candidates: candidates as never[],
    });
    validateRoutingPolicy(policy);
    return policy;
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest) {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization routing access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'models.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('models.manage permission is required');
  }
}
