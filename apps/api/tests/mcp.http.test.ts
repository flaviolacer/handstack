import { IdentityAdministrationService } from '@handstack/identity-service';
import { CapabilityExecutionEngine, InMemoryCapabilityRegistry } from '@handstack/capabilities';
import { McpServer } from '@handstack/mcp-server';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { CapabilityRuntimeService } from '../src/capabilities/capability-runtime.service.js';
import { AgentRuntimeService } from '../src/agents/agent-runtime.service.js';
import { McpRuntimeService } from '../src/mcp/mcp-runtime.service.js';
import { createApplication } from '../src/main.js';

interface JsonRpcBody {
  readonly result?: {
    readonly tools?: readonly { readonly name: string }[];
    readonly content?: readonly { readonly text?: string }[];
  };
}

describe('MCP HTTP contract', () => {
  let app: NestFastifyApplication;
  let token: string;
  const organizationId = 'mcp-http-organization';
  const password = 'mcp administrator password long enough';
  const originalMcpTimeout = process.env.HANDSTACK_MCP_TIMEOUT_MS;

  beforeAll(async () => {
    process.env.HANDSTACK_MCP_TIMEOUT_MS = '1000';
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    process.env.HANDSTACK_ACCESS_TOKEN_SECRET = 'mcp-http-access-secret-at-least-32-characters';
    process.env.HANDSTACK_TOKEN_PEPPER = 'mcp-http-token-pepper-at-least-32-characters';
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const auth = app.get(AuthRuntimeService);
    const administration = new IdentityAdministrationService(auth.storage);
    await administration.createUser(organizationId, {
      id: 'mcp-admin',
      username: 'mcp.admin',
      displayName: 'MCP Admin',
    });
    const role = await administration.createRole(organizationId, { name: 'MCP administrator' });
    for (const name of [
      'mcp.manage',
      'mcp.use',
      'capability.execute',
      'mcp.extra',
      'agents.execute',
    ]) {
      const permission = await administration.createPermission(organizationId, name);
      await administration.grantPermission(organizationId, role.id, permission.id);
    }
    await administration.assignRole(organizationId, 'mcp-admin', role.id);
    await auth.authentication.setPassword(organizationId, 'mcp-admin', password);
    token = (await auth.authentication.login(organizationId, 'mcp.admin', password)).accessToken;
    const capabilities = app.get(CapabilityRuntimeService);
    await capabilities.registry.register({
      organizationId,
      slug: 'mcp-echo',
      name: 'MCP Echo',
      description: 'Echo through MCP',
      type: 'CUSTOM',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      requiredPermissions: ['capability.execute', 'mcp.extra'],
      allowedChannels: ['MCP'],
      timeoutMs: 1000,
      visibility: 'ORGANIZATION',
      ownerId: 'mcp-admin',
      metadata: {},
      handler: (input) => Promise.resolve({ echoed: input }),
    });
    await capabilities.registry.publish(organizationId, 'mcp-echo');
    const agents = app.get(AgentRuntimeService);
    const agent = await agents.create({
      organizationId,
      slug: 'mcp-agent',
      name: 'MCP Agent',
    });
    const version = await agents.createVersion({
      organizationId,
      agentId: agent.id,
      model: 'mcp-agent-model',
      systemPrompt: 'Respond to MCP prompts',
      configuration: { publishChannels: ['MCP'] },
    });
    await agents.publish(organizationId, agent.id, version.id);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
    delete process.env.HANDSTACK_ACCESS_TOKEN_SECRET;
    delete process.env.HANDSTACK_TOKEN_PEPPER;
    if (originalMcpTimeout === undefined) delete process.env.HANDSTACK_MCP_TIMEOUT_MS;
    else process.env.HANDSTACK_MCP_TIMEOUT_MS = originalMcpTimeout;
  });

  it('connects to a loopback MCP server, persists discovery and executes a tool', async () => {
    const externalOrganization = 'external-mcp-organization';
    const externalRegistry = new InMemoryCapabilityRegistry();
    await externalRegistry.register({
      organizationId: externalOrganization,
      slug: 'loopback.echo',
      name: 'Loopback Echo',
      description: 'Echo through the external MCP server implementation',
      type: 'CUSTOM',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      requiredPermissions: ['mcp.use'],
      allowedChannels: ['MCP'],
      timeoutMs: 1000,
      visibility: 'ORGANIZATION',
      ownerId: 'external-owner',
      metadata: {},
      published: false,
      handler: (input, context) =>
        Promise.resolve({
          echoed: input,
          channel: context.channel,
          principalId: context.principalId,
        }),
    });
    const externalEngine = new CapabilityExecutionEngine(externalRegistry, {
      authorize: ({ capability, context }) =>
        capability.requiredPermissions.every((permission) =>
          context.permissions?.includes(permission),
        )
          ? Promise.resolve()
          : Promise.reject(new Error('external MCP permission denied')),
    });
    const externalMcpServer = new McpServer(externalRegistry, externalEngine);
    const externalPrincipal = {
      organizationId: externalOrganization,
      subject: 'external-mcp-principal',
      permissions: ['mcp.use'],
    } as const;
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        let message: unknown;
        try {
          message = JSON.parse(body) as unknown;
        } catch {
          response.writeHead(400);
          response.end();
          return;
        }
        void externalMcpServer
          .handle(message, {
            organizationId: externalOrganization,
            principal: externalPrincipal,
          })
          .then((result) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(result));
          })
          .catch(() => {
            response.writeHead(500);
            response.end();
          });
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Loopback server did not bind');
    const runtime = app.get(McpRuntimeService);
    const serverId = 'loopback-external';
    try {
      await expect(
        externalMcpServer.handle(
          { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          { organizationId: externalOrganization, principal: externalPrincipal },
        ),
      ).resolves.toMatchObject({ result: { tools: [] } });
      await externalRegistry.publish(externalOrganization, 'loopback.echo');
      await runtime.register({
        id: serverId,
        organizationId,
        name: 'Loopback external MCP',
        transport: 'STREAMABLE_HTTP',
        url: `http://127.0.0.1:${String(address.port)}`,
        allowedPermissions: ['mcp.use'],
      });
      await expect(runtime.discover(organizationId, serverId)).resolves.toMatchObject([
        { name: 'loopback.echo', requiredPermissions: [] },
      ]);
      const reconnected = await app.inject({
        method: 'POST',
        url: `/mcp/servers/${organizationId}/${serverId}/reconnect`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(reconnected.statusCode).toBe(201);
      expect(reconnected.json()).toMatchObject({
        organizationId,
        serverId,
        reconnected: true,
      });
      await runtime.clients.purgeOrganization(organizationId);
      await expect(runtime.listTools(organizationId, serverId)).resolves.toMatchObject([
        { name: 'loopback.echo' },
      ]);
      await expect(
        runtime.execute(
          organizationId,
          serverId,
          'loopback.echo',
          { value: 1 },
          {
            organizationId,
            principalId: 'mcp-admin',
            permissions: ['mcp.use'],
          },
        ),
      ).resolves.toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              echoed: { value: 1 },
              channel: 'MCP',
              principalId: externalPrincipal.subject,
            }),
          },
        ],
      });
    } finally {
      await runtime.clients.purgeOrganization(organizationId);
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it('applies the configured MCP timeout to external discovery requests', async () => {
    const server = createServer((_request, response) => {
      const timer = setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: 'slow', result: { tools: [] } }));
      }, 2_000);
      response.on('close', () => {
        clearTimeout(timer);
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Slow loopback MCP server did not bind');
    const runtime = app.get(McpRuntimeService);
    const serverId = 'loopback-slow';
    try {
      await runtime.register({
        id: serverId,
        organizationId,
        name: 'Slow loopback MCP',
        transport: 'STREAMABLE_HTTP',
        url: `http://127.0.0.1:${String(address.port)}`,
        allowedPermissions: [],
      });
      await expect(runtime.discover(organizationId, serverId)).rejects.toMatchObject({
        name: 'TimeoutError',
      });
    } finally {
      await runtime.clients.purgeOrganization(organizationId);
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it('authenticates initialize, filters tools and delegates calls to the common engine', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const agent = app.get(AgentRuntimeService);
    const agentRun = vi.spyOn(agent, 'runPublished').mockResolvedValue({
      runId: 'mcp-agent-run',
      content: 'agent response',
      iterations: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    try {
      const initialize = await app.inject({
        method: 'POST',
        url: `/mcp/${organizationId}`,
        headers,
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
      });
      expect(initialize.statusCode).toBe(201);
      expect(initialize.json()).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
      const listed = await app.inject({
        method: 'POST',
        url: `/mcp/${organizationId}`,
        headers,
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      });
      const listedBody = JSON.parse(listed.body) as unknown as JsonRpcBody;
      expect(listedBody.result?.tools?.some((tool) => tool.name === 'mcp-echo')).toBe(true);
      const called = await app.inject({
        method: 'POST',
        url: `/mcp/${organizationId}`,
        headers,
        payload: {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'mcp-echo', arguments: { ok: true } },
        },
      });
      expect(JSON.parse(called.body) as unknown as JsonRpcBody).toMatchObject({
        result: { content: [{ text: '{"echoed":{"ok":true}}' }] },
      });
      const crossTenant = await app.inject({
        method: 'POST',
        url: '/mcp/other-organization',
        headers,
        payload: { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      });
      expect(crossTenant.statusCode).toBe(403);
      expect(listedBody.result?.tools?.some((tool) => tool.name === 'agent.mcp-agent')).toBe(true);
      const agentCalled = await app.inject({
        method: 'POST',
        url: `/mcp/${organizationId}`,
        headers,
        payload: {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'agent.mcp-agent', arguments: { prompt: 'Summarize' } },
        },
      });
      const agentBody = JSON.parse(agentCalled.body) as unknown as JsonRpcBody;
      expect(agentBody.result?.content?.[0]?.text).toContain('agent response');
      const call = agentRun.mock.calls[0]?.[0] as
        { readonly channel?: string; readonly permissions?: readonly string[] } | undefined;
      expect(call?.channel).toBe('MCP');
      expect(call?.permissions).toContain('agents.execute');
    } finally {
      agentRun.mockRestore();
    }
  });
});
