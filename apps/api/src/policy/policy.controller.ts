import type { AuthorizationPolicy, AuthorizationRequest } from '@handstack/policy';
import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { PolicyRuntimeService } from './policy-runtime.service.js';

@ApiTags('Policies')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/policies')
@UseGuards(AccessTokenGuard)
export class PolicyController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(PolicyRuntimeService) private readonly runtime: PolicyRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  @ApiOperation({ summary: 'List tenant authorization policies' })
  async list(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.runtime.list(organizationId) };
  }

  @Post()
  @ApiOperation({ summary: 'Create a tenant authorization policy' })
  async create(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorize(organizationId, request);
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw new ValidationError('Policy body must be an object');
    const candidate = body as Record<string, unknown>;
    const principalIds = candidate.principalIds;
    const resource = candidate.resource;
    const action = candidate.action;
    const effect = candidate.effect;
    if (
      !Array.isArray(principalIds) ||
      principalIds.length === 0 ||
      principalIds.some((id) => typeof id !== 'string' || id.trim() === '')
    )
      throw new ValidationError('Policy principalIds are required');
    if (
      typeof resource !== 'string' ||
      resource.trim() === '' ||
      typeof action !== 'string' ||
      action.trim() === ''
    )
      throw new ValidationError('Policy resource and action are required');
    if (effect !== 'allow' && effect !== 'deny')
      throw new ValidationError('Policy effect must be allow or deny');
    const policy = {
      principalIds: principalIds as string[],
      resource: resource.trim(),
      action: action.trim(),
      effect,
    } as Omit<AuthorizationPolicy, 'id' | 'organizationId'>;
    if (candidate.conditions !== undefined) {
      return this.runtime.create(organizationId, {
        ...policy,
        conditions: candidate.conditions as NonNullable<AuthorizationPolicy['conditions']>,
      });
    }
    return this.runtime.create(organizationId, policy);
  }

  @Post('evaluate')
  @ApiOperation({ summary: 'Evaluate a persisted tenant authorization policy' })
  async evaluate(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorize(organizationId, request);
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw new ValidationError('Authorization request must be an object');
    const candidate = body as Record<string, unknown>;
    if (
      typeof candidate.principalId !== 'string' ||
      typeof candidate.resource !== 'string' ||
      typeof candidate.action !== 'string' ||
      !Array.isArray(candidate.groupIds)
    )
      throw new ValidationError('principalId, resource, action and groupIds are required');
    return this.runtime.authorize({
      organizationId,
      principalId: candidate.principalId,
      resource: candidate.resource,
      action: candidate.action,
      groupIds: candidate.groupIds.filter((id): id is string => typeof id === 'string'),
      evaluatedAt: new Date(),
    } satisfies AuthorizationRequest);
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest) {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization policy access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'policy.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('policy.manage permission is required');
  }
}
