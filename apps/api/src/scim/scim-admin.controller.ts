import { AuthorizationError } from '@handstack/shared';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { Controller, Delete, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { ScimRuntimeService } from './scim-runtime.service.js';

@Controller('api/v1/organizations/:organizationId/scim')
@UseGuards(AccessTokenGuard)
export class ScimAdminController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(ScimRuntimeService) private readonly runtime: ScimRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  async endpoint(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const keyId = await this.runtime.credentials.credentialKeyId(organizationId);
    return {
      baseUrl: '/scim/v2',
      authentication: 'oauthbearertoken',
      hasCredential: keyId !== undefined,
      ...(keyId === undefined ? {} : { keyId }),
    };
  }

  @Post('credential')
  async issueCredential(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.runtime.credentials.issue(organizationId);
  }

  @Delete('credential')
  async revokeCredential(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ revoked: true }> {
    await this.authorize(organizationId, request);
    await this.runtime.credentials.revoke(organizationId);
    return { revoked: true };
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest): Promise<void> {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId) {
      throw new AuthorizationError('Cross-organization SCIM administration is forbidden');
    }
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'identity.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('identity.manage permission is required');
  }
}
