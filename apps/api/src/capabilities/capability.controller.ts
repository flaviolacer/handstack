import { AuthorizationError, ValidationError } from '@handstack/shared';
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
import { z } from 'zod';

const descriptorSchema = z
  .object({
    slug: z.string().trim().min(2).max(63),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000),
    type: z.enum(['TOOL', 'AGENT', 'WORKFLOW', 'KNOWLEDGE', 'PLUGIN', 'CUSTOM']),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()),
    requiredPermissions: z.array(z.string().trim().min(1)).max(100),
    allowedChannels: z
      .array(z.enum(['WEB', 'API', 'MCP', 'INTERNAL', 'AGENT']))
      .min(1)
      .max(5),
    budgetPolicy: z.object({ estimateUsd: z.number().nonnegative() }).optional(),
    timeoutMs: z.number().int().positive().max(3_600_000),
    visibility: z.enum(['PRIVATE', 'ORGANIZATION', 'PUBLIC']),
    ownerId: z.string().trim().min(1),
    metadata: z.record(z.string(), z.string()),
  })
  .strict();

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

  @Post()
  @ApiOperation({ summary: 'Register a capability descriptor' })
  async create(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorizeManagement(organizationId, request);
    const parsed = descriptorSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid capability');
    const descriptor = parsed.data;
    return this.runtime.registry.registerDescriptor({
      organizationId,
      slug: descriptor.slug,
      name: descriptor.name,
      description: descriptor.description,
      type: descriptor.type,
      inputSchema: descriptor.inputSchema,
      outputSchema: descriptor.outputSchema,
      requiredPermissions: descriptor.requiredPermissions,
      allowedChannels: descriptor.allowedChannels,
      timeoutMs: descriptor.timeoutMs,
      visibility: descriptor.visibility,
      ownerId: descriptor.ownerId,
      metadata: descriptor.metadata,
      ...(descriptor.budgetPolicy === undefined ? {} : { budgetPolicy: descriptor.budgetPolicy }),
    });
  }

  @Post(':slug/publish')
  @ApiOperation({ summary: 'Publish a capability descriptor' })
  async publish(
    @Param('organizationId') organizationId: string,
    @Param('slug') slug: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorizeManagement(organizationId, request);
    return this.runtime.registry.publish(organizationId, slug);
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

  private async authorizeManagement(
    organizationId: string,
    request: AuthenticatedRequest,
  ): Promise<void> {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization capability access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'capability.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('capability.manage permission is required');
  }
}

@ApiTags('Capabilities')
@ApiBearerAuth()
@Controller('api/v1/capabilities')
@UseGuards(AccessTokenGuard)
export class PublicCapabilityController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(CapabilityRuntimeService) private readonly runtime: CapabilityRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  @ApiOperation({ summary: 'List capabilities for the authenticated organization' })
  async list(@Req() request: AuthenticatedRequest) {
    const organizationId = await this.authorize(request);
    return { items: await this.runtime.registry.list(organizationId, 'API') };
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Resolve a capability for the authenticated organization' })
  async get(@Param('slug') slug: string, @Req() request: AuthenticatedRequest) {
    const organizationId = await this.authorize(request);
    const entry = await this.runtime.registry.get(organizationId, slug);
    if (!entry?.capability.allowedChannels.includes('API'))
      throw new AuthorizationError('Capability is unavailable');
    return entry.capability;
  }

  @Post(':slug/run')
  @ApiOperation({ summary: 'Execute a capability for the authenticated organization' })
  async run(
    @Param('slug') slug: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const authentication = requireAuthentication(request);
    await this.authorize(request);
    return this.runtime.engine.execute(slug, body, {
      organizationId: authentication.organizationId,
      principalId: authentication.subject,
      channel: 'API',
    });
  }

  private async authorize(request: AuthenticatedRequest): Promise<string> {
    const authentication = requireAuthentication(request);
    const decision = await this.administration.authorize({
      organizationId: authentication.organizationId,
      principalId: authentication.subject,
      permission: 'capability.execute',
    });
    if (!decision.allowed)
      throw new AuthorizationError('capability.execute permission is required');
    return authentication.organizationId;
  }
}
