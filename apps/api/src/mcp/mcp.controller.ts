import { McpServer } from '@handstack/mcp-server';
import type { McpAdditionalTool } from '@handstack/mcp-server';
import type { McpOAuthConfig, McpTransportKind } from '@handstack/mcp-client';
import { AuthorizationError } from '@handstack/shared';
import { createMcpMetricsObserver } from '@handstack/telemetry';
import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ValidationError } from '@handstack/shared';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { CapabilityRuntimeService } from '../capabilities/capability-runtime.service.js';
import { AuthRuntimeService } from '../auth/auth-runtime.service.js';
import { ApiMetrics } from '../observability/api-metrics.js';
import { McpRuntimeService } from './mcp-runtime.service.js';
import { IdentityAdministrationService } from '@handstack/identity-service';
import { AgentRuntimeService } from '../agents/agent-runtime.service.js';

@ApiTags('MCP')
@ApiBearerAuth()
@Controller('mcp')
@UseGuards(AccessTokenGuard)
export class McpController {
  constructor(
    @Inject(CapabilityRuntimeService) private readonly runtime: CapabilityRuntimeService,
    @Inject(ApiMetrics) private readonly metrics: ApiMetrics,
    @Inject(McpRuntimeService) private readonly mcpRuntime: McpRuntimeService,
    @Inject(AgentRuntimeService) private readonly agents: AgentRuntimeService,
    @Inject(AuthRuntimeService) auth: AuthRuntimeService,
  ) {
    this.administration = new IdentityAdministrationService(auth.storage);
  }

  private readonly administration: IdentityAdministrationService;

  @Get('servers/:organizationId')
  @ApiOperation({ summary: 'List configured MCP client servers for an organization' })
  async listServers(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorizeManagement(organizationId, request);
    return { items: await this.mcpRuntime.list(organizationId) };
  }

  @Post('servers/:organizationId')
  @ApiOperation({ summary: 'Register an organization MCP client server' })
  async registerServer(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() value: unknown,
  ) {
    await this.authorizeManagement(organizationId, request);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new ValidationError('MCP server body must be an object');
    const body = value as Record<string, unknown>;
    const id = body.id;
    const name = body.name;
    const transport = body.transport;
    if (
      typeof id !== 'string' ||
      typeof name !== 'string' ||
      typeof transport !== 'string' ||
      id.trim() === '' ||
      name.trim() === ''
    )
      throw new ValidationError('MCP server id, name and transport are required');
    if (
      transport === 'STREAMABLE_HTTP' &&
      (typeof body.url !== 'string' || !body.url.startsWith('https://'))
    )
      throw new ValidationError('MCP HTTP server requires an HTTPS URL');
    if (transport === 'STDIO' && (typeof body.command !== 'string' || body.command.trim() === ''))
      throw new ValidationError('MCP stdio server requires a command');
    let oauth: McpOAuthConfig | undefined;
    if (body.oauth !== undefined) {
      if (
        !isRecord(body.oauth) ||
        typeof body.oauth.authorizationUrl !== 'string' ||
        typeof body.oauth.tokenUrl !== 'string' ||
        typeof body.oauth.clientId !== 'string' ||
        typeof body.oauth.redirectUri !== 'string'
      )
        throw new ValidationError('MCP OAuth configuration is invalid');
      if (
        ![body.oauth.authorizationUrl, body.oauth.tokenUrl, body.oauth.redirectUri].every((value) =>
          value.startsWith('https://'),
        )
      )
        throw new ValidationError('MCP OAuth URLs must use HTTPS');
      oauth = {
        authorizationUrl: body.oauth.authorizationUrl,
        tokenUrl: body.oauth.tokenUrl,
        clientId: body.oauth.clientId,
        redirectUri: body.oauth.redirectUri,
        ...(Array.isArray(body.oauth.scopes)
          ? { scopes: body.oauth.scopes.filter((item): item is string => typeof item === 'string') }
          : {}),
      };
    }
    const server = {
      id: id.trim(),
      organizationId,
      name: name.trim(),
      transport: transport as McpTransportKind,
      ...(typeof body.url === 'string' ? { url: body.url.trim() } : {}),
      ...(typeof body.command === 'string' ? { command: body.command.trim() } : {}),
      ...(Array.isArray(body.args)
        ? { args: body.args.filter((item): item is string => typeof item === 'string') }
        : {}),
      ...(oauth === undefined ? {} : { oauth }),
      allowedPermissions: Array.isArray(body.allowedPermissions)
        ? body.allowedPermissions.filter((item): item is string => typeof item === 'string')
        : [],
    };
    return this.mcpRuntime.register(server);
  }

  @Post('servers/:organizationId/:serverId/discover')
  @ApiOperation({ summary: 'Discover tools exposed by an MCP client server' })
  async discover(
    @Param('organizationId') organizationId: string,
    @Param('serverId') serverId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorizeManagement(organizationId, request);
    return { items: await this.mcpRuntime.discover(organizationId, serverId) };
  }

  @Post('servers/:organizationId/:serverId/reconnect')
  @ApiOperation({ summary: 'Reconnect an MCP client server transport' })
  async reconnect(
    @Param('organizationId') organizationId: string,
    @Param('serverId') serverId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorizeManagement(organizationId, request);
    return this.mcpRuntime.reconnect(organizationId, serverId);
  }

  @Get('servers/:organizationId/:serverId/tools')
  @ApiOperation({ summary: 'List tools discovered from an MCP client server' })
  async listTools(
    @Param('organizationId') organizationId: string,
    @Param('serverId') serverId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorizeManagement(organizationId, request);
    return { items: await this.mcpRuntime.listTools(organizationId, serverId) };
  }

  @Post('servers/:organizationId/:serverId/discover-resources')
  @ApiOperation({ summary: 'Discover resources exposed by an MCP client server' })
  async discoverResources(
    @Param('organizationId') organizationId: string,
    @Param('serverId') serverId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorizeManagement(organizationId, request);
    return { items: await this.mcpRuntime.discoverResources(organizationId, serverId) };
  }

  @Get('servers/:organizationId/:serverId/resources')
  @ApiOperation({ summary: 'List persisted MCP resources for an MCP client server' })
  async listResources(
    @Param('organizationId') organizationId: string,
    @Param('serverId') serverId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorizeManagement(organizationId, request);
    return { items: await this.mcpRuntime.listResources(organizationId, serverId) };
  }

  @Post('servers/:organizationId/:serverId/discover-prompts')
  @ApiOperation({ summary: 'Discover prompts exposed by an MCP client server' })
  async discoverPrompts(
    @Param('organizationId') organizationId: string,
    @Param('serverId') serverId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorizeManagement(organizationId, request);
    return { items: await this.mcpRuntime.discoverPrompts(organizationId, serverId) };
  }

  @Get('servers/:organizationId/:serverId/prompts')
  @ApiOperation({ summary: 'List persisted MCP prompts for an MCP client server' })
  async listPrompts(
    @Param('organizationId') organizationId: string,
    @Param('serverId') serverId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.authorizeManagement(organizationId, request);
    return { items: await this.mcpRuntime.listPrompts(organizationId, serverId) };
  }

  @Post('servers/:organizationId/:serverId/tools/:toolName/call')
  @ApiOperation({ summary: 'Execute a discovered MCP tool for the authenticated principal' })
  async callTool(
    @Param('organizationId') organizationId: string,
    @Param('serverId') serverId: string,
    @Param('toolName') toolName: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const authentication = await this.authorizeUse(organizationId, request);
    const permissions = await this.administration.listPrincipalPermissions(
      organizationId,
      authentication.subject,
    );
    const argumentsValue = isRecord(body) && 'arguments' in body ? body.arguments : body;
    return this.mcpRuntime.execute(organizationId, serverId, toolName, argumentsValue, {
      organizationId,
      principalId: authentication.subject,
      permissions,
    });
  }

  @Post('servers/:organizationId/:serverId/credentials')
  @ApiOperation({ summary: 'Store an encrypted per-user MCP credential' })
  async saveCredential(
    @Param('organizationId') organizationId: string,
    @Param('serverId') serverId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    await this.authorizeManagement(organizationId, request);
    if (
      !isRecord(body) ||
      typeof body.type !== 'string' ||
      typeof body.secret !== 'string' ||
      body.secret.trim() === ''
    )
      throw new ValidationError('MCP credential type and secret are required');
    const types = ['API_KEY', 'BEARER', 'OAUTH2', 'OIDC', 'CUSTOM_HEADERS'] as const;
    if (!types.includes(body.type as (typeof types)[number]))
      throw new ValidationError('Unsupported MCP credential type');
    const authentication = requireAuthentication(request);
    return this.mcpRuntime.saveCredential({
      organizationId,
      serverId,
      principalId: authentication.subject,
      type: body.type as (typeof types)[number],
      secret: body.secret,
    });
  }

  @Post('servers/:organizationId/:serverId/oauth/start')
  @ApiOperation({ summary: 'Start an MCP OAuth authorization-code flow' })
  async startOAuth(
    @Param('organizationId') organizationId: string,
    @Param('serverId') serverId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const authentication = await this.authorizeUse(organizationId, request);
    return this.mcpRuntime.beginOAuth(organizationId, serverId, authentication.subject);
  }

  @Post('servers/:organizationId/:serverId/oauth/callback')
  @ApiOperation({ summary: 'Complete an MCP OAuth authorization-code flow' })
  async completeOAuth(
    @Param('organizationId') organizationId: string,
    @Param('serverId') serverId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const authentication = await this.authorizeUse(organizationId, request);
    if (!isRecord(body) || typeof body.state !== 'string' || typeof body.code !== 'string')
      throw new ValidationError('MCP OAuth state and code are required');
    return this.mcpRuntime.completeOAuth(
      organizationId,
      serverId,
      authentication.subject,
      body.state,
      body.code,
    );
  }

  @Post()
  @ApiOperation({ summary: 'Serve the MCP JSON-RPC endpoint' })
  async handle(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.handleRequest(undefined, request, body);
  }

  @Post(':organizationId')
  @ApiOperation({ summary: 'Serve the organization-scoped MCP JSON-RPC endpoint' })
  async handleOrganization(
    @Param('organizationId') organizationId: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.handleRequest(organizationId, request, body);
  }

  private async handleRequest(
    organizationId: string | undefined,
    request: AuthenticatedRequest,
    body: unknown,
  ) {
    const authentication = requireAuthentication(request);
    const targetOrganization = organizationId ?? authentication.organizationId;
    if (targetOrganization !== authentication.organizationId)
      throw new AuthorizationError('Cross-organization MCP access is forbidden');
    const permissions = await this.administration.listPrincipalPermissions(
      targetOrganization,
      authentication.subject,
    );
    const server = new McpServer(
      this.runtime.registry,
      this.runtime.engine,
      undefined,
      [],
      [],
      createMcpMetricsObserver(this.metrics),
      async (principal) => this.agentTools(principal),
    );
    return server.handle(body, {
      organizationId: targetOrganization,
      principal: {
        organizationId: targetOrganization,
        subject: authentication.subject,
        permissions,
      },
      requestId: request.id,
    });
  }

  private async agentTools(principal: {
    readonly organizationId: string;
    readonly subject: string;
    readonly permissions: readonly string[];
  }): Promise<readonly McpAdditionalTool[]> {
    const agents = await this.agents.list(principal.organizationId);
    const tools: McpAdditionalTool[] = [];
    for (const agent of agents) {
      const published = (await this.agents.versionsFor(principal.organizationId, agent.id)).find(
        (version) =>
          version.status === 'PUBLISHED' && version.configuration?.publishChannels?.includes('MCP'),
      );
      if (published === undefined) continue;
      tools.push({
        name: `agent.${agent.slug}`,
        description: `Run published agent ${agent.name}`,
        inputSchema: {
          type: 'object',
          properties: { prompt: { type: 'string', minLength: 1 } },
          required: ['prompt'],
          additionalProperties: false,
        },
        requiredPermissions: ['agents.execute'],
        execute: async (input, context) => {
          if (!isRecord(input) || typeof input.prompt !== 'string' || input.prompt.trim() === '')
            throw new ValidationError('Agent MCP tool requires a prompt');
          return this.agents.runPublished({
            organizationId: principal.organizationId,
            agentId: agent.id,
            principalId: principal.subject,
            prompt: input.prompt,
            channel: 'MCP',
            ...(context.permissions === undefined ? {} : { permissions: context.permissions }),
          });
        },
      });
    }
    return tools;
  }

  private async authorizeManagement(
    organizationId: string,
    request: AuthenticatedRequest,
  ): Promise<void> {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization MCP access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'mcp.manage',
    });
    if (!decision.allowed) throw new AuthorizationError('mcp.manage permission is required');
  }

  private async authorizeUse(organizationId: string, request: AuthenticatedRequest) {
    const authentication = requireAuthentication(request);
    if (authentication.organizationId !== organizationId)
      throw new AuthorizationError('Cross-organization MCP access is forbidden');
    const decision = await this.administration.authorize({
      organizationId,
      principalId: authentication.subject,
      permission: 'mcp.use',
    });
    if (!decision.allowed) throw new AuthorizationError('mcp.use permission is required');
    return authentication;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
