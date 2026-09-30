import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Patch, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import { DatabaseService } from './database.service.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import type { HandStackConfigLayer } from '@handstack/config';

function objectBody(value: unknown): HandStackConfigLayer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Database settings must be an object');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'database')) {
    throw new ValidationError('The primary database adapter and URL are startup-only settings');
  }
  return value;
}

@Controller('api/v1/admin/settings/database')
@UseGuards(AccessTokenGuard)
export class DatabaseSettingsController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  async get(@Req() request: AuthenticatedRequest): Promise<HandStackConfigLayer> {
    await this.authorize(request);
    return this.database.getDatabaseSettings();
  }

  @Patch()
  async update(
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ): Promise<HandStackConfigLayer> {
    await this.authorize(request);
    try {
      return await this.database.updateDatabaseSettings(objectBody(value));
    } catch (cause) {
      throw new ValidationError(
        cause instanceof Error ? cause.message : 'Invalid database settings',
      );
    }
  }

  private async authorize(request: AuthenticatedRequest): Promise<void> {
    const authentication = requireAuthentication(request);
    const decision = await this.administration.authorize({
      organizationId: authentication.organizationId,
      principalId: authentication.subject,
      permission: 'settings.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('settings.manage permission is required');
  }
}
