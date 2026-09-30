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

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Request body must be an object');
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  if (body[key] === undefined) return undefined;
  return requiredString(body, key);
}

@Controller('api/v1/organizations/:organizationId')
@UseGuards(AccessTokenGuard)
export class DirectoryController {
  private readonly administration: IdentityAdministrationService;

  constructor(@Inject(AuthRuntimeService) auth: AuthRuntimeService) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get('users')
  async users(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.administration.listUsers(organizationId) };
  }

  @Post('users')
  async createUser(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return this.administration.createUser(organizationId, {
      username: requiredString(body, 'username'),
      displayName: requiredString(body, 'displayName'),
      ...(body.email === undefined ? {} : { email: requiredString(body, 'email') }),
    });
  }

  @Patch('users/:userId')
  async updateUser(
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    const displayName = optionalString(body, 'displayName');
    return this.administration.updateUser(organizationId, userId, {
      ...(displayName === undefined ? {} : { displayName }),
      ...(body.email === undefined ? {} : { email: requiredString(body, 'email') }),
    });
  }

  @Get('groups')
  async groups(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.administration.listGroups(organizationId) };
  }

  @Post('groups')
  async createGroup(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return this.administration.createGroup(organizationId, {
      name: requiredString(body, 'name'),
      ...(body.description === undefined
        ? {}
        : { description: requiredString(body, 'description') }),
    });
  }

  @Patch('groups/:groupId')
  async updateGroup(
    @Param('organizationId') organizationId: string,
    @Param('groupId') groupId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return this.administration.updateGroup(organizationId, groupId, {
      ...(body.name === undefined ? {} : { name: requiredString(body, 'name') }),
      ...(body.description === undefined
        ? {}
        : { description: requiredString(body, 'description') }),
    });
  }

  @Get('roles')
  async roles(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.administration.listRoles(organizationId) };
  }

  @Post('roles')
  async createRole(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return this.administration.createRole(organizationId, {
      name: requiredString(body, 'name'),
      ...(body.description === undefined
        ? {}
        : { description: requiredString(body, 'description') }),
    });
  }

  @Patch('roles/:roleId')
  async updateRole(
    @Param('organizationId') organizationId: string,
    @Param('roleId') roleId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return this.administration.updateRole(organizationId, roleId, {
      ...(body.name === undefined ? {} : { name: requiredString(body, 'name') }),
      ...(body.description === undefined
        ? {}
        : { description: requiredString(body, 'description') }),
    });
  }

  @Get('group-memberships')
  async groupMemberships(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.administration.listGroupMemberships(organizationId) };
  }

  @Post('group-memberships')
  async addPrincipalToGroup(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return this.administration.addPrincipalToGroup(
      organizationId,
      requiredString(body, 'groupId'),
      requiredString(body, 'principalId'),
    );
  }

  @Delete('group-memberships')
  async removePrincipalFromGroup(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return {
      removed: await this.administration.removePrincipalFromGroup(
        organizationId,
        requiredString(body, 'groupId'),
        requiredString(body, 'principalId'),
      ),
    };
  }

  @Get('principal-roles')
  async principalRoles(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.administration.listPrincipalRoles(organizationId) };
  }

  @Post('principal-roles')
  async assignRole(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return this.administration.assignRole(
      organizationId,
      requiredString(body, 'principalId'),
      requiredString(body, 'roleId'),
    );
  }

  @Delete('principal-roles')
  async unassignRole(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return {
      removed: await this.administration.unassignRole(
        organizationId,
        requiredString(body, 'principalId'),
        requiredString(body, 'roleId'),
      ),
    };
  }

  @Get('permissions')
  async permissions(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.administration.listPermissions(organizationId) };
  }

  @Post('permissions')
  async createPermission(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return this.administration.createPermission(
      organizationId,
      requiredString(body, 'permission'),
      typeof body.id === 'string' ? body.id : undefined,
    );
  }

  @Get('role-permissions')
  async rolePermissions(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return { items: await this.administration.listRolePermissions(organizationId) };
  }

  @Post('role-permissions')
  async grantPermission(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return this.administration.grantPermission(
      organizationId,
      requiredString(body, 'roleId'),
      requiredString(body, 'permissionId'),
    );
  }

  @Delete('role-permissions')
  async revokePermission(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    return {
      removed: await this.administration.revokePermission(
        organizationId,
        requiredString(body, 'roleId'),
        requiredString(body, 'permissionId'),
      ),
    };
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest): Promise<void> {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId) {
      throw new AuthorizationError('Cross-organization directory access is forbidden');
    }
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'identity.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('identity.manage permission is required');
  }
}
