import { PluginRegistryRuntimeService } from './plugin-registry.runtime.js';
import { Body, Controller, Get, Inject, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { PluginCatalog } from '@handstack/plugins';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import type { AuthenticatedRequest } from '../auth/authentication-context.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { requireAuthentication } from '../auth/authentication-context.js';
import { AuthorizationError, ValidationError } from '@handstack/shared';

@ApiTags('Plugin Registry')
@Controller('registry/plugins')
@UseGuards(AccessTokenGuard)
export class PluginRegistryController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(PluginRegistryRuntimeService) private readonly runtime: PluginRegistryRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  @ApiOperation({ summary: 'List official, community, installed or update plugins' })
  @ApiQuery({
    name: 'catalog',
    required: false,
    enum: ['OFFICIAL', 'COMMUNITY', 'INSTALLED', 'UPDATES'],
  })
  async list(
    @Query('catalog') catalog: PluginCatalog | undefined,
    @Query('search') search: string | undefined,
    @Query('organizationId') organizationId: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const selected = catalog ?? 'OFFICIAL';
    if (selected === 'INSTALLED' || selected === 'UPDATES')
      await this.authorizeTenantCatalog(organizationId, request);
    return { items: await this.runtime.search(search ?? '', selected, organizationId) };
  }

  @Get(':name')
  @ApiOperation({ summary: 'Resolve a plugin registry entry' })
  get(@Param('name') name: string, @Query('version') version?: string) {
    return this.runtime.registry.get(name, version);
  }

  @Patch(':name/quarantine')
  @ApiOperation({ summary: 'Quarantine a tenant plugin version' })
  async quarantine(
    @Param('name') name: string,
    @Query('organizationId') organizationId: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const tenantId = await this.authorizeTenantCatalog(organizationId, request);
    const input = controlBody(value, true);
    const authentication = requireAuthentication(request);
    return this.runtime.quarantine(
      tenantId,
      name,
      input.version,
      authentication.subject,
      input.reason,
    );
  }

  @Patch(':name/revoke-publisher')
  @ApiOperation({ summary: 'Revoke a plugin publisher for a tenant' })
  async revokePublisher(
    @Param('name') publisher: string,
    @Query('organizationId') organizationId: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const tenantId = await this.authorizeTenantCatalog(organizationId, request);
    const input = controlBody(value, false);
    const authentication = requireAuthentication(request);
    return this.runtime.revokePublisher(tenantId, publisher, authentication.subject, input.reason);
  }

  private async authorizeTenantCatalog(
    organizationId: string | undefined,
    request: AuthenticatedRequest,
  ): Promise<string> {
    if (organizationId === undefined || organizationId.trim() === '')
      throw new AuthorizationError('organizationId is required for tenant plugin catalogs');
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization plugin catalog access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'plugins.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('plugins.manage permission is required');
    return organizationId;
  }
}

function controlBody(value: unknown, withVersion: boolean): { version: string; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ValidationError('Plugin control body must be an object');
  const body = value as Record<string, unknown>;
  if (typeof body.reason !== 'string' || body.reason.trim() === '')
    throw new ValidationError('Plugin control reason is required');
  if (withVersion && (typeof body.version !== 'string' || body.version.trim() === ''))
    throw new ValidationError('Plugin version is required for quarantine');
  return { version: typeof body.version === 'string' ? body.version : '', reason: body.reason };
}
