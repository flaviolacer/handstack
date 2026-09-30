import type { IdentityProvider, OrganizationLoginMode } from '@handstack/identity';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { AuthorizationError, ValidationError } from '@handstack/shared';
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AccessTokenGuard } from './access-token.guard.js';
import { AuthRuntimeService } from './auth-runtime.service.js';
import { requireAuthentication, type AuthenticatedRequest } from './authentication-context.js';
import { OidcRuntimeService } from './oidc-runtime.service.js';
import { IdentityAdminTelemetryInterceptor } from './identity-admin-telemetry.interceptor.js';

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Request body must be an object');
  }
  return value as Record<string, unknown>;
}

function stringValue(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ValidationError(`${key} must be a boolean`);
  return value;
}

function publicProvider(provider: IdentityProvider) {
  return {
    id: provider.id,
    organizationId: provider.organizationId,
    pluginId: provider.pluginId,
    name: provider.name,
    slug: provider.slug,
    type: provider.type,
    enabled: provider.enabled,
    priority: provider.priority,
    configuration: provider.configuration,
    hasClientSecret: provider.clientSecretReference !== undefined,
    loginPolicy: provider.loginPolicy,
    provisioningPolicy: provider.provisioningPolicy,
    mappingPolicy: provider.mappingPolicy,
    version: provider.version,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

@Controller('organizations/:organizationId/identity')
@UseGuards(AccessTokenGuard)
@UseInterceptors(IdentityAdminTelemetryInterceptor)
export class IdentityAdminController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(AuthRuntimeService) private readonly auth: AuthRuntimeService,
    @Inject(OidcRuntimeService) private readonly oidc: OidcRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get('providers')
  async listProviders(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return (await this.oidc.providers.list(organizationId)).map(publicProvider);
  }

  @Get('users')
  async listUsers(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.administration.listUsers(organizationId);
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
      ...(body.id === undefined ? {} : { id: stringValue(body, 'id') }),
      username: stringValue(body, 'username'),
      displayName: stringValue(body, 'displayName'),
      ...(body.email === undefined ? {} : { email: stringValue(body, 'email') }),
    });
  }

  @Get('groups')
  async listGroups(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.administration.listGroups(organizationId);
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
      ...(body.id === undefined ? {} : { id: stringValue(body, 'id') }),
      name: stringValue(body, 'name'),
      ...(body.description === undefined ? {} : { description: stringValue(body, 'description') }),
    });
  }

  @Get('roles')
  async listRoles(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.administration.listRoles(organizationId);
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
      ...(body.id === undefined ? {} : { id: stringValue(body, 'id') }),
      name: stringValue(body, 'name'),
      ...(body.description === undefined ? {} : { description: stringValue(body, 'description') }),
    });
  }

  @Post('providers')
  async createProvider(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    const configuration = objectBody(body.configuration);
    const scopes = configuration.scopes;
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) {
      throw new ValidationError('configuration.scopes must be an array of strings');
    }
    const provider = await this.oidc.providers.create(organizationId, {
      pluginId: stringValue(body, 'pluginId'),
      name: stringValue(body, 'name'),
      slug: stringValue(body, 'slug'),
      configuration: {
        issuer: stringValue(configuration, 'issuer'),
        clientId: stringValue(configuration, 'clientId'),
        redirectUri: stringValue(configuration, 'redirectUri'),
        scopes,
      },
      ...(body.clientSecretReference === undefined
        ? {}
        : { clientSecretReference: stringValue(body, 'clientSecretReference') }),
      loginPolicy: {
        accountLinking: body.accountLinking === 'VERIFIED_EMAIL' ? 'VERIFIED_EMAIL' : 'DISABLED',
      },
      provisioningPolicy: { jitEnabled: optionalBoolean(body, 'jitEnabled') ?? false },
    });
    return publicProvider(provider);
  }

  @Patch('providers/:providerId/enabled')
  async setProviderEnabled(
    @Param('organizationId') organizationId: string,
    @Param('providerId') providerId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const enabled = optionalBoolean(objectBody(value), 'enabled');
    if (enabled === undefined) throw new ValidationError('enabled is required');
    return publicProvider(
      await this.oidc.providers.setEnabled(organizationId, providerId, enabled),
    );
  }

  @Get('providers/:providerId/mappings')
  async listMappings(
    @Param('organizationId') organizationId: string,
    @Param('providerId') providerId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.oidc.providers.listMappings(organizationId, providerId);
  }

  @Post('providers/:providerId/test-connection')
  async testProviderConnection(
    @Param('organizationId') organizationId: string,
    @Param('providerId') providerId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.oidc.testConnection(organizationId, providerId);
  }

  @Patch('providers/:providerId/mappings')
  async setMappings(
    @Param('organizationId') organizationId: string,
    @Param('providerId') providerId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    if (!Array.isArray(value)) throw new ValidationError('Request body must be an array');
    return this.oidc.providers.setMappings(
      organizationId,
      providerId,
      value.map((item) => {
        const body = objectBody(item);
        const targetType = body.targetType;
        if (targetType !== 'GROUP' && targetType !== 'ROLE') {
          throw new ValidationError('targetType must be GROUP or ROLE');
        }
        const enabled = optionalBoolean(body, 'enabled');
        return {
          sourceClaim: stringValue(body, 'sourceClaim'),
          sourceValue: stringValue(body, 'sourceValue'),
          targetType,
          targetId: stringValue(body, 'targetId'),
          ...(enabled === undefined ? {} : { enabled }),
        };
      }),
    );
  }

  @Get('login-policy')
  async loginPolicy(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.oidc.providers.loginPolicy(organizationId);
  }

  @Patch('login-policy')
  async setLoginPolicy(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request);
    const body = objectBody(value);
    const modes: readonly OrganizationLoginMode[] = [
      'LOCAL_ALLOWED',
      'LOCAL_DISABLED',
      'SSO_REQUIRED',
      'SPECIFIC_IDP_REQUIRED',
    ];
    const mode = body.mode;
    if (typeof mode !== 'string' || !modes.includes(mode as OrganizationLoginMode)) {
      throw new ValidationError('mode is invalid');
    }
    const maximum = body.maxBreakGlassAccounts;
    if (maximum !== undefined && typeof maximum !== 'number') {
      throw new ValidationError('maxBreakGlassAccounts must be a number');
    }
    const breakGlassEnabled = optionalBoolean(body, 'breakGlassEnabled');
    return this.oidc.providers.setLoginPolicy(organizationId, {
      mode: mode as OrganizationLoginMode,
      ...(body.requiredProviderId === undefined
        ? {}
        : { requiredProviderId: stringValue(body, 'requiredProviderId') }),
      ...(breakGlassEnabled === undefined ? {} : { breakGlassEnabled }),
      ...(maximum === undefined ? {} : { maxBreakGlassAccounts: maximum }),
    });
  }

  @Post('break-glass/:userId')
  async enableBreakGlass(
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ): Promise<{ enabled: true }> {
    await this.authorize(organizationId, request);
    await this.auth.authentication.enableBreakGlass(
      organizationId,
      userId,
      stringValue(objectBody(value), 'password'),
    );
    return { enabled: true };
  }

  @Patch('break-glass/:userId/disable')
  async disableBreakGlass(
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ enabled: false }> {
    await this.authorize(organizationId, request);
    await this.auth.authentication.disableBreakGlass(organizationId, userId);
    return { enabled: false };
  }

  @Patch('users/:userId/deprovision')
  async deprovisionUser(
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request);
    return this.administration.deprovisionUser(organizationId, userId);
  }

  private async authorize(organizationId: string, request: AuthenticatedRequest): Promise<void> {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId) {
      throw new AuthorizationError('Cross-organization identity administration is forbidden');
    }
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'identity.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('identity.manage permission is required');
  }
}
