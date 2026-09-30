import { AuthorizationError, ValidationError } from '@handstack/shared';
import { Body, Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
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
import type { AgentVersionConfiguration } from '@handstack/agents';
import type { FastifyReply } from 'fastify';

const createSchema = z.object({
  slug: z.string().trim().min(2).max(63),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).optional(),
});
const configurationSchema = z.object({
  mcpServers: z.array(z.string().trim().min(1)).max(100).optional(),
  knowledgeBaseIds: z.array(z.string().trim().min(1)).max(100).optional(),
  memoryEnabled: z.boolean().optional(),
  guardrails: z.array(z.string().trim().min(1)).max(100).optional(),
  permissions: z.array(z.string().trim().min(1)).max(100).optional(),
  publishChannels: z
    .array(z.enum(['WEB', 'REST_API', 'MCP', 'AGENT_TOOL']))
    .max(4)
    .optional(),
});
const versionSchema = z.object({
  model: z.string().trim().min(1),
  systemPrompt: z.string().min(1).max(100_000),
  tools: z.array(z.string().trim().min(1)).max(100).optional(),
  maxIterations: z.number().int().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
  budgetUsd: z.number().nonnegative().optional(),
  configuration: configurationSchema.optional(),
});
const runSchema = z
  .object({
    prompt: z.string().trim().min(1).max(100_000).optional(),
    repository: z.string().trim().min(1).max(2_000).optional(),
  })
  .refine((value) => value.prompt !== undefined || value.repository !== undefined, {
    message: 'prompt or repository is required',
  });

function resolveRunPrompt(value: z.infer<typeof runSchema>): string {
  if (value.prompt !== undefined) return value.prompt;
  if (value.repository !== undefined) return `Review repository: ${value.repository}`;
  throw new ValidationError('prompt or repository is required');
}

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

  @Get('templates')
  @ApiOperation({ summary: 'List first-party agent templates' })
  async templates(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'agents.read');
    return { items: this.runtime.listTemplates() };
  }

  @Post('templates/:templateId/install')
  @ApiOperation({ summary: 'Install a first-party agent template' })
  async installTemplate(
    @Param('organizationId') organizationId: string,
    @Param('templateId') templateId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'agents.manage');
    return this.runtime.installTemplate(organizationId, templateId);
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

  @Get(':agentId/runs')
  @ApiOperation({ summary: 'List persisted agent runs' })
  async runs(
    @Param('organizationId') organizationId: string,
    @Param('agentId') agentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'agents.read');
    return { items: await this.runtime.listRuns(organizationId, agentId) };
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
      ...(parsed.data.configuration === undefined
        ? {}
        : { configuration: normalizeConfiguration(parsed.data.configuration) }),
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

  @Post(':agentId/rollback')
  @ApiOperation({ summary: 'Rollback an agent to its previous persisted version' })
  async rollback(
    @Param('organizationId') organizationId: string,
    @Param('agentId') agentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorize(organizationId, request, 'agents.manage');
    return await this.runtime.rollback(organizationId, agentId);
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

@ApiTags('Agents')
@ApiBearerAuth()
@Controller('api/v1/agents')
@UseGuards(AccessTokenGuard)
export class PublicAgentController {
  private readonly administration: IdentityAdministrationService;

  constructor(
    @Inject(AgentRuntimeService) private readonly runtime: AgentRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  @Post(':agentId/run')
  @ApiOperation({ summary: 'Run a published agent' })
  async run(
    @Param('agentId') agentId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    const authentication = requireAuthentication(request);
    await this.authorize(authentication.organizationId, authentication.subject);
    const parsed = runSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid agent request');
    return this.runtime.runPublished({
      organizationId: authentication.organizationId,
      agentId,
      principalId: authentication.subject,
      prompt: resolveRunPrompt(parsed.data),
      permissions: await this.administration.listPrincipalPermissions(
        authentication.organizationId,
        authentication.subject,
      ),
    });
  }

  @Post(':agentId/stream')
  @ApiOperation({ summary: 'Stream events from a published agent run' })
  async stream(
    @Param('agentId') agentId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
    @Res() reply: FastifyReply,
  ) {
    const authentication = requireAuthentication(request);
    await this.authorize(authentication.organizationId, authentication.subject);
    const parsed = runSchema.safeParse(value);
    if (!parsed.success)
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid agent request');
    reply.hijack();
    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache, no-transform');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.writeHead(200);
    try {
      const result = await this.runtime.runPublished({
        organizationId: authentication.organizationId,
        agentId,
        principalId: authentication.subject,
        prompt: resolveRunPrompt(parsed.data),
        permissions: await this.administration.listPrincipalPermissions(
          authentication.organizationId,
          authentication.subject,
        ),
        onEvent: (event) => {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      });
      reply.raw.write(`data: ${JSON.stringify({ type: 'agent.result', result })}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    } catch (error) {
      reply.raw.write(
        `data: ${JSON.stringify({ type: 'agent.error', error: error instanceof Error ? error.message : String(error) })}\n\n`,
      );
      reply.raw.end();
    }
  }

  private async authorize(organizationId: string, principalId: string): Promise<void> {
    const decision = await this.administration.authorize({
      organizationId,
      principalId,
      permission: 'agents.execute',
    });
    if (!decision.allowed) throw new AuthorizationError('agents.execute permission is required');
  }
}

function normalizeConfiguration(
  value: z.infer<typeof configurationSchema>,
): AgentVersionConfiguration {
  return {
    ...(value.mcpServers === undefined ? {} : { mcpServers: value.mcpServers }),
    ...(value.knowledgeBaseIds === undefined ? {} : { knowledgeBaseIds: value.knowledgeBaseIds }),
    ...(value.memoryEnabled === undefined ? {} : { memoryEnabled: value.memoryEnabled }),
    ...(value.guardrails === undefined ? {} : { guardrails: value.guardrails }),
    ...(value.permissions === undefined ? {} : { permissions: value.permissions }),
    ...(value.publishChannels === undefined ? {} : { publishChannels: value.publishChannels }),
  };
}
