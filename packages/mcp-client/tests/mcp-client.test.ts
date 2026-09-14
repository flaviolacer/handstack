import { describe, expect, it, vi } from 'vitest';
import { CapabilityExecutionEngine, InMemoryCapabilityRegistry } from '@handstack/capabilities';
import { McpClientRegistry } from '../src/index.js';

describe('MCP client registry', () => {
  it('emits safe observations for discovery, calls and failures', async () => {
    const observations: {
      operation: string;
      method: string;
      outcome: string;
      durationMs: number;
    }[] = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { tools: [{ name: 'ping', inputSchema: {} }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new McpClientRegistry((observation) => observations.push(observation));
    registry.register({
      id: 'observed',
      organizationId: 'org',
      name: 'Observed',
      transport: 'STREAMABLE_HTTP',
      url: 'https://mcp.example.test',
      allowedPermissions: [],
    });
    await registry.discover('org', 'observed');
    await registry.execute(
      'org',
      'observed',
      'ping',
      {},
      {
        organizationId: 'org',
        principalId: 'user',
        permissions: [],
      },
    );
    expect(observations).toHaveLength(2);
    expect(
      observations.map(({ operation, method, outcome }) => [operation, method, outcome]),
    ).toEqual([
      ['discover', 'tools/list', 'success'],
      ['call', 'tools/call', 'success'],
    ]);
    expect(observations.every(({ durationMs }) => Number.isFinite(durationMs))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('discovers and executes an authenticated HTTP tool with permissions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => ({
        result:
          fetchMock.mock.calls.length === 1
            ? { tools: [{ name: 'search', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'ok' }] },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new McpClientRegistry();
    registry.register({
      id: 'server',
      organizationId: 'org',
      name: 'External',
      transport: 'STREAMABLE_HTTP',
      url: 'https://mcp.example.test',
      auth: { type: 'BEARER', secret: 'token' },
      allowedPermissions: ['mcp.use'],
    });
    await expect(registry.discover('org', 'server')).resolves.toHaveLength(1);
    const capabilityRegistry = new InMemoryCapabilityRegistry();
    await expect(
      registry.registerCapabilities(capabilityRegistry, 'org', 'server', 'owner'),
    ).resolves.toEqual(['search']);
    const engine = new CapabilityExecutionEngine(capabilityRegistry, {
      authorize: () => Promise.resolve(),
    });
    await expect(
      registry.execute(
        'org',
        'server',
        'search',
        { q: 'x' },
        { organizationId: 'org', principalId: 'user', permissions: ['mcp.use'] },
      ),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    const calls = fetchMock.mock.calls as unknown as readonly unknown[][];
    const firstCall = calls[0];
    const firstInit = firstCall?.[1] as { headers?: unknown } | undefined;
    expect(firstInit?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer token' }));
    await expect(
      registry.execute(
        'org',
        'server',
        'search',
        {},
        { organizationId: 'org', principalId: 'user', permissions: [] },
      ),
    ).rejects.toThrow(/permission/);
    await expect(
      engine.execute(
        'search',
        { q: 'agent' },
        {
          organizationId: 'org',
          principalId: 'agent',
          permissions: ['mcp.use'],
          channel: 'AGENT',
        },
      ),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    vi.unstubAllGlobals();
  });

  it('uses newline-delimited JSON-RPC over stdio', async () => {
    const script =
      "process.stdin.setEncoding('utf8'); let b=''; process.stdin.on('data',c=>{b+=c; const i=b.indexOf('\\n'); if(i<0)return; const r=JSON.parse(b.slice(0,i)); b=b.slice(i+1); const result=r.method==='tools/list'?{tools:[{name:'ping',inputSchema:{}}]}:{content:[{type:'text',text:'pong'}]}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});";
    const registry = new McpClientRegistry();
    registry.register({
      id: 'stdio',
      organizationId: 'org',
      name: 'Local',
      transport: 'STDIO',
      command: process.execPath,
      args: ['-e', script],
      allowedPermissions: [],
    });
    await expect(registry.discover('org', 'stdio')).resolves.toEqual([
      { name: 'ping', inputSchema: {}, requiredPermissions: [] },
    ]);
    await expect(
      registry.execute(
        'org',
        'stdio',
        'ping',
        {},
        {
          organizationId: 'org',
          principalId: 'user',
          permissions: [],
        },
      ),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'pong' }] });
    await registry.close('org', 'stdio');
  });

  it('discovers resources and prompts and resolves a per-user credential', async () => {
    const fetchMock = vi.fn((_: unknown, init?: RequestInit) => {
      const rawBody = init?.body;
      const body = JSON.parse(typeof rawBody === 'string' ? rawBody : '') as { method: string };
      const result =
        body.method === 'resources/list'
          ? { resources: [{ uri: 'https://example.test/a', name: 'a' }] }
          : body.method === 'prompts/list'
            ? { prompts: [{ name: 'summarize', arguments: [{ name: 'text', required: true }] }] }
            : body.method === 'tools/list'
              ? { tools: [{ name: 'summarize', inputSchema: {} }] }
              : { content: [{ type: 'text', text: 'ok' }] };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new McpClientRegistry();
    registry.register({
      id: 'user-server',
      organizationId: 'org',
      name: 'User',
      transport: 'STREAMABLE_HTTP',
      endpoint: 'https://mcp.example.test',
      credentialResolver: (context) => Promise.resolve(context.credential),
      allowedPermissions: [],
    });
    await expect(registry.discoverResources('org', 'user-server')).resolves.toEqual([
      { uri: 'https://example.test/a', name: 'a' },
    ]);
    await expect(registry.discoverPrompts('org', 'user-server')).resolves.toEqual([
      { name: 'summarize', arguments: [{ name: 'text', required: true }] },
    ]);
    await registry.discover('org', 'user-server');
    await expect(
      registry.execute(
        'org',
        'user-server',
        'summarize',
        {},
        {
          organizationId: 'org',
          principalId: 'user',
          permissions: [],
          credential: { type: 'OAUTH2', secret: 'user-token' },
        },
      ),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    const lastCall = fetchMock.mock.calls.at(-1) as unknown as
      readonly [unknown, RequestInit] | undefined;
    const headers = lastCall?.[1].headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer user-token');
    vi.unstubAllGlobals();
  });

  it('observes invalid discovery responses and credential resolver failures', async () => {
    const observations: { method: string; outcome: string; durationMs: number }[] = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { invalid: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new McpClientRegistry((observation) => observations.push(observation));
    registry.register({
      id: 'invalid',
      organizationId: 'org',
      name: 'Invalid',
      transport: 'STREAMABLE_HTTP',
      url: 'https://mcp.example.test',
      allowedPermissions: [],
    });
    await expect(registry.discover('org', 'invalid')).rejects.toThrow(/invalid response/);
    expect(observations).toMatchObject([{ method: 'tools/list', outcome: 'error' }]);

    registry.register({
      id: 'resolver-error',
      organizationId: 'org',
      name: 'Resolver error',
      transport: 'STREAMABLE_HTTP',
      url: 'https://mcp.example.test',
      credentialResolver: () => Promise.reject(new Error('credential unavailable')),
      allowedPermissions: [],
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { tools: [{ name: 'ping', inputSchema: {} }] } }),
    });
    await registry.discover('org', 'resolver-error');
    await expect(
      registry.execute(
        'org',
        'resolver-error',
        'ping',
        {},
        {
          organizationId: 'org',
          principalId: 'user',
          permissions: [],
        },
      ),
    ).rejects.toThrow('credential unavailable');
    expect(observations.at(-1)).toMatchObject({ method: 'tools/call', outcome: 'error' });
    vi.unstubAllGlobals();
  });
});
