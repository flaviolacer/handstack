import { CapabilityExecutionEngine, InMemoryCapabilityRegistry } from '@handstack/capabilities';
import { describe, expect, it } from 'vitest';
import { McpServer } from '../src/index.js';

describe('MCP server', () => {
  it('emits method outcome and duration without request payloads', async () => {
    const observations: { method: string; outcome: string; durationMs: number }[] = [];
    const server = new McpServer(
      new InMemoryCapabilityRegistry(),
      new CapabilityExecutionEngine(new InMemoryCapabilityRegistry(), {
        authorize: () => Promise.resolve(),
      }),
      undefined,
      [],
      [],
      (observation) => observations.push(observation),
    );
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { organizationId: 'org' });
    expect(observations).toMatchObject([{ method: 'tools/list', outcome: 'error' }]);
    expect(Number.isFinite(observations[0]?.durationMs)).toBe(true);
  });

  it('observes malformed JSON-RPC requests as errors without recording the payload', async () => {
    const observations: { method: string; outcome: string; durationMs: number }[] = [];
    const server = new McpServer(
      new InMemoryCapabilityRegistry(),
      new CapabilityExecutionEngine(new InMemoryCapabilityRegistry(), {
        authorize: () => Promise.resolve(),
      }),
      undefined,
      [],
      [],
      (observation) => observations.push(observation),
    );
    await expect(
      server.handle({ secret: 'must-not-observe' }, { organizationId: 'org' }),
    ).resolves.toMatchObject({
      error: { code: -32600 },
    });
    expect(observations).toMatchObject([{ method: 'invalid_request', outcome: 'error' }]);
    expect(JSON.stringify(observations)).not.toContain('must-not-observe');
  });

  it('lists and executes only published MCP capabilities for the principal tenant', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await registry.register({
      organizationId: 'org',
      slug: 'echo',
      name: 'Echo',
      description: 'Echo input',
      type: 'TOOL',
      inputSchema: { type: 'object' },
      outputSchema: {},
      requiredPermissions: ['mcp.echo'],
      allowedChannels: ['MCP'],
      timeoutMs: 1000,
      visibility: 'ORGANIZATION',
      ownerId: 'owner',
      metadata: {},
      handler: (input) => Promise.resolve(input),
    });
    const engine = new CapabilityExecutionEngine(registry, {
      authorize: ({ capability, context }) =>
        capability.requiredPermissions.every((permission) =>
          context.permissions?.includes(permission),
        )
          ? Promise.resolve()
          : Promise.reject(new Error('permission denied')),
    });
    const server = new McpServer(registry, engine);
    await expect(
      server.handle(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        {
          organizationId: 'org',
          principal: { organizationId: 'org', subject: 'user', permissions: ['mcp.echo'] },
        },
      ),
    ).resolves.toMatchObject({ result: { tools: [{ name: 'echo' }] } });
    await expect(
      server.handle(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'echo', arguments: { ok: true } },
        },
        {
          organizationId: 'org',
          principal: { organizationId: 'org', subject: 'user', permissions: ['mcp.echo'] },
        },
      ),
    ).resolves.toMatchObject({ result: { content: [{ text: '{"ok":true}' }] } });
    await expect(
      server.handle(
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: {} } },
        {
          organizationId: 'other',
          principal: { organizationId: 'other', subject: 'user', permissions: ['mcp.echo'] },
        },
      ),
    ).resolves.toMatchObject({ error: { code: -32602 } });
  });

  it('requires authentication before discovery and supports resources/prompts', async () => {
    const registry = new InMemoryCapabilityRegistry();
    const engine = new CapabilityExecutionEngine(registry, { authorize: () => Promise.resolve() });
    const server = new McpServer(
      registry,
      engine,
      undefined,
      [{ uri: 'file://a', name: 'a' }],
      [{ name: 'summarize' }],
    );
    await expect(
      server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { organizationId: 'org' }),
    ).resolves.toMatchObject({ error: { code: -32001 } });
    await expect(
      server.handle(
        { jsonrpc: '2.0', id: 2, method: 'resources/list' },
        {
          organizationId: 'org',
          principal: { organizationId: 'org', subject: 'u', permissions: [] },
        },
      ),
    ).resolves.toMatchObject({ result: { resources: [{ name: 'a' }] } });
    await expect(
      server.handle(
        { jsonrpc: '2.0', id: 3, method: 'prompts/list' },
        {
          organizationId: 'org',
          principal: { organizationId: 'org', subject: 'u', permissions: [] },
        },
      ),
    ).resolves.toMatchObject({ result: { prompts: [{ name: 'summarize' }] } });
  });
});
