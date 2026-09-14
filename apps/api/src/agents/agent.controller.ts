import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { AgentRuntimeService } from './agent-runtime.service.js';

const createSchema = z.object({
  slug: z.string().trim().min(2).max(63),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).optional(),
});
const versionSchema = z.object({
  model: z.string().trim().min(1),
  systemPrompt: z.string().min(1).max(100_000),
  tools: z.array(z.string().trim().min(1)).max(100).optional(),
  maxIterations: z.number().int().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
  budgetUsd: z.number().nonnegative().optional(),
});

@ApiTags('Agents')
@ApiBearerAuth()
@Controller('api/v1/organizations/:organizationId/agents')
@UseGuards(AccessTokenGuard)
export class AgentController {
  private readonly administration: IdentityAdministrationService;
  constructor(
    @Inject(AgentRuntimeService) private readonly runtime: AgentRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Get()
  @ApiOperation({ summary: 'List agents for an organization' })
  async list(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'agents.read');
    return { items: await this.runtime.list(organizationId) };
  }

  @Post()
  @ApiOperation({ summary: 'Create an agent' })
  async create(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'agents.manage');
    const parsed = createSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid agent');
    return await this.runtime.create({
      organizationId,
      slug: parsed.data.slug,
      name: parsed.data.name,
      ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }),
    });
  }

  @Get(':agentId/versions')
  @ApiOperation({ summary: 'List agent versions' })
  async versions(
    @Param('organizationId') organizationId: string,
    @Param('agentId') agentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'agents.read');
    return { items: await this.runtime.versionsFor(organizationId, agentId) };
  }

  @Post(':agentId/versions')
  @ApiOperation({ summary: 'Create an agent version' })
  async createVersion(
    @Param('organizationId') organizationId: string,
    @Param('agentId') agentId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorize(organizationId, request, 'agents.manage');
    const parsed = versionSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid agent version');
    return await this.runtime.createVersion({
      organizationId,
      agentId,
      model: parsed.data.model,
      systemPrompt: parsed.data.systemPrompt,
      ...(parsed.data.tools === undefined ? {} : { tools: parsed.data.tools }),
      ...(parsed.data.maxIterations === undefined
        ? {}
        : { maxIterations: parsed.data.maxIterations }),
      ...(parsed.data.timeoutMs === undefined ? {} : { timeoutMs: parsed.data.timeoutMs }),
      ...(parsed.data.budgetUsd === undefined ? {} : { budgetUsd: parsed.data.budgetUsd }),
    });
  }

  @Post(':agentId/versions/:versionId/publish')
  @ApiOperation({ summary: 'Publish one agent version' })
  async publish(
    @Param('organizationId') organizationId: string,
    @Param('agentId') agentId: string,
    @Param('versionId') versionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'agents.manage');
    return await this.runtime.publish(organizationId, agentId, versionId);
  }

  private async authorize(
    organizationId: string,
    request: AuthenticatedRequest,
    permission: string,
  ) {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization agent access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission,
    });
    if (!decision.allowed) throw new AuthorizationError(`${permission} permission is required`);
  }
}
