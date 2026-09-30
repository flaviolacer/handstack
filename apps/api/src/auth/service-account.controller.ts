import { IdentityAdministrationService } from '@handstack/identity-service';
import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AccessTokenGuard } from './access-token.guard.js';
import { AuthRuntimeService } from './auth-runtime.service.js';
import { requireAuthentication, type AuthenticatedRequest } from './authentication-context.js';
import { ServiceAccountRuntimeService } from './service-account-runtime.service.js';

const createSchema = z.object({
  displayName: z.string().trim().min(1),
  scopes: z.array(z.string().trim().min(1)).min(1),
  expiresAt: z.coerce.date().optional(),
});
function publicAccount(account: { secretHash: string; [key: string]: unknown }) {
  return Object.fromEntries(Object.entries(account).filter(([key]) => key !== 'secretHash'));
}

@ApiTags('Service accounts')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/service-accounts')
@UseGuards(AccessTokenGuard)
export class ServiceAccountController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(ServiceAccountRuntimeService) private readonly runtime: ServiceAccountRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  @ApiOperation({ summary: 'List tenant service accounts without secrets' })
  async list(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return {
      items: (await this.runtime.service.list(organizationId)).map((account) =>
        publicAccount(account as unknown as { secretHash: string; [key: string]: unknown }),
      ),
    };
  }

  @Post()
  @ApiOperation({ summary: 'Issue a tenant service account; secret returned once' })
  async create(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const parsed = createSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid service account');
    const input =
      parsed.data.expiresAt === undefined
        ? { organizationId, displayName: parsed.data.displayName, scopes: parsed.data.scopes }
        : {
            organizationId,
            displayName: parsed.data.displayName,
            scopes: parsed.data.scopes,
            expiresAt: parsed.data.expiresAt,
          };
    const issued = await this.runtime.service.issue(input);
    return {
      account: publicAccount(
        issued.account as unknown as { secretHash: string; [key: string]: unknown },
      ),
      secret: issued.secret,
    };
  }

  @Post(':accountId/rotate')
  @ApiOperation({ summary: 'Rotate a tenant service account secret' })
  async rotate(
    @Param('organizationId') organizationId: string,
    @Param('accountId') accountId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    const issued = await this.runtime.service.rotate(organizationId, accountId);
    return {
      account: publicAccount(
        issued.account as unknown as { secretHash: string; [key: string]: unknown },
      ),
      secret: issued.secret,
    };
  }

  @Patch(':accountId/revoke')
  @ApiOperation({ summary: 'Revoke a tenant service account' })
  async revoke(
    @Param('organizationId') organizationId: string,
    @Param('accountId') accountId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    await this.runtime.service.revoke(organizationId, accountId);
    return { revoked: true };
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest) {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization service account access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'identity.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('identity.manage permission is required');
  }
}
