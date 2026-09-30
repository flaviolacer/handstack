import { IdentityAdministrationService } from '@handstack/identity-service';
import { AuthorizationError, ValidationError } from '@handstack/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { SecretRuntimeService } from './secret-runtime.service.js';

function bodyObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ValidationError('Request body must be an object');
  return value as Record<string, unknown>;
}
function required(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '')
    throw new ValidationError(`${key} is required`);
  return value.trim();
}

@Controller('api/v1/organizations/:organizationId/secrets')
@UseGuards(AccessTokenGuard)
export class SecretController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(SecretRuntimeService) private readonly runtime: SecretRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }
  @Get()
  async list(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.list(organizationId);
  }
  @Post()
  async create(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const authentication = await this.authorize(organizationId, request);
    const body = bodyObject(value);
    return this.runtime.create({
      organizationId,
      actorId: authentication.subject,
      name: required(body, 'name'),
      pluginId: required(body, 'pluginId'),
      value: required(body, 'value'),
    });
  }
  @Patch(':secretId/rotate')
  async rotate(
    @Param('organizationId') organizationId: string,
    @Param('secretId') secretId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const authentication = await this.authorize(organizationId, request);
    return this.runtime.rotate(
      organizationId,
      authentication.subject,
      secretId,
      required(bodyObject(value), 'value'),
    );
  }
  @Delete(':secretId')
  async remove(
    @Param('organizationId') organizationId: string,
    @Param('secretId') secretId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const authentication = await this.authorize(organizationId, request);
    await this.runtime.remove(organizationId, authentication.subject, secretId);
    return { deleted: true };
  }
  private async authorize(organizationId: string, request: AuthenticatedRequest) {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization secret access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'settings.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('settings.manage permission is required');
    return authentication;
  }
}
