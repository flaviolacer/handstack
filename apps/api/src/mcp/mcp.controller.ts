import { McpServer } from '@handstack/mcp-server';
import { AuthorizationError } from '@handstack/shared';
import { createMcpMetricsObserver } from '@handstack/telemetry';
import { Body, Controller, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import {
  requireAuthentication,
  type AuthenticatedRequest,
} from '../auth/authentication-context.js';
import { CapabilityRuntimeService } from '../capabilities/capability-runtime.service.js';
import { ApiMetrics } from '../observability/api-metrics.js';

@ApiTags('MCP')
@ApiBearerAuth()
@Controller('mcp')
@UseGuards(AccessTokenGuard)
export class McpController {
  constructor(
    @Inject(CapabilityRuntimeService) private readonly runtime: CapabilityRuntimeService,
    @Inject(ApiMetrics) private readonly metrics: ApiMetrics,
  ) {}

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
    const server = new McpServer(
      this.runtime.registry,
      this.runtime.engine,
      undefined,
      [],
      [],
      createMcpMetricsObserver(this.metrics),
    );
    return server.handle(body, {
      organizationId: targetOrganization,
      principal: {
        organizationId: targetOrganization,
        subject: authentication.subject,
        permissions: ['capability.execute'],
      },
      requestId: request.id,
    });
  }
}
