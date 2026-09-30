import { ValidationError } from '@handstack/shared';
import type { CapabilityRegistry } from '@handstack/capabilities';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

export type McpTransportKind = 'STREAMABLE_HTTP' | 'STDIO';
export type McpAuthType = 'NONE' | 'API_KEY' | 'BEARER' | 'OAUTH2' | 'OIDC' | 'CUSTOM_HEADERS';

export interface McpCredential {
  readonly type: McpAuthType;
  readonly secret?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface McpServerConfig {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly transport: McpTransportKind;
  readonly url?: string;
  readonly endpoint?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly auth?: McpCredential;
  readonly oauth?: McpOAuthConfig;
  readonly credentialResolver?: (context: McpCallContext) => Promise<McpCredential | undefined>;
  readonly allowedPermissions: readonly string[];
}

export interface McpOAuthConfig {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly scopes?: readonly string[];
  readonly redirectUri: string;
}

export interface McpOAuthAuthorization {
  readonly state: string;
  readonly authorizationUrl: string;
}

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly requiredPermissions: readonly string[];
}

export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpPrompt {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly { readonly name: string; readonly required?: boolean }[];
}

export interface McpCallContext {
  readonly organizationId: string;
  readonly principalId: string;
  readonly permissions: readonly string[];
  readonly credential?: McpCredential;
  readonly signal?: AbortSignal;
}

export interface McpObservation {
  readonly operation: 'discover' | 'call';
  readonly method: string;
  readonly outcome: 'success' | 'error';
  readonly durationMs: number;
}

export type McpObservationSink = (observation: McpObservation) => void;

export interface McpTransport {
  request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    credential?: McpCredential | (() => Promise<McpCredential | undefined>),
  ): Promise<unknown>;
  close(): Promise<void>;
}

class StreamableHttpTransport implements McpTransport {
  constructor(private readonly config: McpServerConfig) {}

  async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    credential?: McpCredential,
  ) {
    const endpoint = this.config.endpoint ?? this.config.url;
    if (endpoint === undefined || endpoint === '')
      throw new ValidationError('MCP HTTP URL is required');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const configuredAuth = credential ?? this.config.auth;
    if (
      configuredAuth?.type === 'BEARER' ||
      configuredAuth?.type === 'OAUTH2' ||
      configuredAuth?.type === 'OIDC'
    ) {
      if (configuredAuth.secret !== undefined)
        headers.authorization = `Bearer ${configuredAuth.secret}`;
    } else if (configuredAuth?.type === 'API_KEY' && configuredAuth.secret !== undefined) {
      headers.authorization = `Api-Key ${configuredAuth.secret}`;
    } else if (configuredAuth?.type === 'CUSTOM_HEADERS' && configuredAuth.headers !== undefined) {
      Object.assign(headers, configuredAuth.headers);
    }
    const requestInit: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      ...(signal === undefined ? {} : { signal }),
    };
    const response = await fetch(endpoint, requestInit);
    if (!response.ok) throw new Error(`MCP server returned HTTP ${String(response.status)}`);
    const value = (await response.json()) as unknown;
    if (!isRecord(value) || ('error' in value && value.error !== undefined))
      throw new Error('MCP server returned a JSON-RPC error');
    return value.result;
  }

  close() {
    return Promise.resolve();
  }
}

class StdioTransport implements McpTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private buffer = '';

  constructor(config: McpServerConfig) {
    if (config.command === undefined || config.command === '')
      throw new ValidationError('MCP stdio command is required');
    this.process = spawn(config.command, [...(config.args ?? [])], {
      stdio: 'pipe',
      windowsHide: true,
    });
    this.process.stdout.on('data', (chunk: Buffer) => {
      this.consume(chunk.toString('utf8'));
    });
    this.process.on('error', (error) => {
      this.pending.forEach(({ reject }) => {
        reject(error);
      });
    });
  }

  request(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('MCP request aborted'));
        return;
      }
      const abort = () => {
        this.pending.delete(id);
        reject(new Error('MCP request aborted'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    while (this.buffer.includes('\n')) {
      const index = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(value) || typeof value.id !== 'string') continue;
      const pending = this.pending.get(value.id);
      if (pending === undefined) continue;
      this.pending.delete(value.id);
      if ('error' in value && value.error !== undefined)
        pending.reject(new Error('MCP JSON-RPC error'));
      else pending.resolve(value.result);
    }
  }

  async close() {
    if (this.process.exitCode === null) {
      this.process.kill();
      await once(this.process, 'close').catch(() => {
        return undefined;
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class McpClientRegistry {
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly transports = new Map<string, McpTransport>();
  private readonly tools = new Map<string, readonly McpTool[]>();
  private readonly resources = new Map<string, readonly McpResource[]>();
  private readonly prompts = new Map<string, readonly McpPrompt[]>();
  private readonly oauthStates = new Map<
    string,
    {
      readonly organizationId: string;
      readonly serverId: string;
      readonly principalId: string;
      readonly config: McpOAuthConfig;
      readonly expiresAt: number;
    }
  >();

  constructor(
    private readonly observe?: McpObservationSink,
    private readonly timeoutMs = 30_000,
    private readonly cacheNamespace = 'handstack:cache',
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new ValidationError('MCP timeout must be a positive integer');
    if (cacheNamespace.trim() === '') throw new ValidationError('MCP cache namespace is required');
  }

  register(server: McpServerConfig): void {
    if (server.organizationId === '' || server.id === '')
      throw new ValidationError('MCP server organization and id are required');
    if (this.servers.has(`${server.organizationId}:${server.id}`))
      throw new ValidationError('MCP server already exists');
    this.servers.set(`${server.organizationId}:${server.id}`, server);
  }

  list(organizationId: string): readonly McpServerConfig[] {
    return [...this.servers.values()].filter((server) => server.organizationId === organizationId);
  }

  async purgeOrganization(organizationId: string): Promise<number> {
    const servers = this.list(organizationId);
    for (const server of servers) await this.close(organizationId, server.id);
    const prefix = `${this.cacheNamespace}:${organizationId}:`;
    for (const key of [...this.tools.keys()]) if (key.startsWith(prefix)) this.tools.delete(key);
    for (const key of [...this.resources.keys()])
      if (key.startsWith(prefix)) this.resources.delete(key);
    for (const key of [...this.prompts.keys()])
      if (key.startsWith(prefix)) this.prompts.delete(key);
    for (const [state, pending] of this.oauthStates)
      if (pending.organizationId === organizationId) this.oauthStates.delete(state);
    return servers.length;
  }

  beginOAuth(
    organizationId: string,
    serverId: string,
    principalId: string,
    now = Date.now(),
  ): McpOAuthAuthorization {
    const server = this.require(organizationId, serverId);
    const oauth = server.oauth;
    if (oauth === undefined) throw new ValidationError('MCP server does not have OAuth configured');
    const state = randomUUID();
    this.oauthStates.set(state, {
      organizationId,
      serverId,
      principalId,
      config: oauth,
      expiresAt: now + 10 * 60_000,
    });
    const authorization = new URL(oauth.authorizationUrl);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('client_id', oauth.clientId);
    authorization.searchParams.set('redirect_uri', oauth.redirectUri);
    authorization.searchParams.set('state', state);
    if (oauth.scopes !== undefined && oauth.scopes.length > 0)
      authorization.searchParams.set('scope', oauth.scopes.join(' '));
    return { state, authorizationUrl: authorization.toString() };
  }

  async completeOAuth(
    organizationId: string,
    serverId: string,
    principalId: string,
    state: string,
    code: string,
    request: typeof fetch = fetch,
    now = Date.now(),
  ): Promise<McpCredential> {
    const pending = this.oauthStates.get(state);
    if (pending === undefined) throw new ValidationError('MCP OAuth state is invalid or expired');
    if (
      pending.organizationId !== organizationId ||
      pending.serverId !== serverId ||
      pending.principalId !== principalId ||
      pending.expiresAt < now
    )
      throw new ValidationError('MCP OAuth state is invalid or expired');
    this.oauthStates.delete(state);
    if (code.trim() === '') throw new ValidationError('MCP OAuth code is required');
    const response = await request(pending.config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: pending.config.clientId,
        redirect_uri: pending.config.redirectUri,
      }).toString(),
    });
    if (!response.ok)
      throw new Error(`MCP OAuth token endpoint returned HTTP ${String(response.status)}`);
    const value = (await response.json()) as unknown;
    if (
      !isRecord(value) ||
      typeof value.access_token !== 'string' ||
      value.access_token.trim() === ''
    )
      throw new ValidationError('MCP OAuth token response is invalid');
    return { type: 'OAUTH2', secret: value.access_token };
  }

  async discover(
    organizationId: string,
    serverId: string,
    signal?: AbortSignal,
  ): Promise<readonly McpTool[]> {
    const server = this.require(organizationId, serverId);
    const discovered = await this.observedRequest(
      'discover',
      'tools/list',
      server,
      signal,
      undefined,
      {},
      (result) => {
        if (!isRecord(result) || !Array.isArray(result.tools))
          throw new Error('MCP tools/list returned an invalid response');
        return result.tools.filter(isRecord).map((tool) => ({
          name: String(tool.name),
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : {},
          requiredPermissions: Array.isArray(tool.requiredPermissions)
            ? tool.requiredPermissions.filter(
                (permission): permission is string => typeof permission === 'string',
              )
            : [],
        }));
      },
    );
    this.tools.set(this.cacheKey(organizationId, serverId), discovered);
    return discovered;
  }

  listTools(organizationId: string, serverId: string): readonly McpTool[] {
    return this.tools.get(this.cacheKey(organizationId, serverId)) ?? [];
  }

  /** Hydrates discovered tool metadata after an API restart. */
  restoreTools(organizationId: string, serverId: string, tools: readonly McpTool[]): void {
    this.tools.set(this.cacheKey(organizationId, serverId), [...tools]);
  }

  /** Hydrates discovery metadata after an API restart without calling the remote server. */
  restoreResources(
    organizationId: string,
    serverId: string,
    resources: readonly McpResource[],
  ): void {
    this.resources.set(this.cacheKey(organizationId, serverId), [...resources]);
  }

  async discoverResources(
    organizationId: string,
    serverId: string,
    signal?: AbortSignal,
  ): Promise<readonly McpResource[]> {
    const discovered = await this.observedRequest(
      'discover',
      'resources/list',
      this.require(organizationId, serverId),
      signal,
      undefined,
      {},
      (result) => {
        if (!isRecord(result) || !Array.isArray(result.resources))
          throw new Error('MCP resources/list returned an invalid response');
        return result.resources.filter(isRecord).map((resource) => ({
          uri: String(resource.uri),
          name: String(resource.name),
          ...(typeof resource.description === 'string'
            ? { description: resource.description }
            : {}),
          ...(typeof resource.mimeType === 'string' ? { mimeType: resource.mimeType } : {}),
        }));
      },
    );
    this.resources.set(this.cacheKey(organizationId, serverId), discovered);
    return discovered;
  }

  listResources(organizationId: string, serverId: string): readonly McpResource[] {
    return this.resources.get(this.cacheKey(organizationId, serverId)) ?? [];
  }

  /** Hydrates prompt discovery metadata after an API restart. */
  restorePrompts(organizationId: string, serverId: string, prompts: readonly McpPrompt[]): void {
    this.prompts.set(this.cacheKey(organizationId, serverId), [...prompts]);
  }

  async discoverPrompts(
    organizationId: string,
    serverId: string,
    signal?: AbortSignal,
  ): Promise<readonly McpPrompt[]> {
    const discovered = await this.observedRequest(
      'discover',
      'prompts/list',
      this.require(organizationId, serverId),
      signal,
      undefined,
      {},
      (result) => {
        if (!isRecord(result) || !Array.isArray(result.prompts))
          throw new Error('MCP prompts/list returned an invalid response');
        return result.prompts.filter(isRecord).map((prompt) => ({
          name: String(prompt.name),
          ...(typeof prompt.description === 'string' ? { description: prompt.description } : {}),
          ...(Array.isArray(prompt.arguments)
            ? {
                arguments: prompt.arguments.filter(isRecord).map((argument) => ({
                  name: String(argument.name),
                  ...(typeof argument.required === 'boolean'
                    ? { required: argument.required }
                    : {}),
                })),
              }
            : {}),
        }));
      },
    );
    this.prompts.set(this.cacheKey(organizationId, serverId), discovered);
    return discovered;
  }

  listPrompts(organizationId: string, serverId: string): readonly McpPrompt[] {
    return this.prompts.get(this.cacheKey(organizationId, serverId)) ?? [];
  }

  /** Exposes discovered MCP tools as AGENT capabilities for AgentHarness. */
  async registerCapabilities(
    registry: CapabilityRegistry,
    organizationId: string,
    serverId: string,
    ownerId: string,
  ): Promise<readonly string[]> {
    const server = this.require(organizationId, serverId);
    const tools = this.listTools(organizationId, serverId);
    if (tools.length === 0) throw new ValidationError('MCP tools must be discovered first');
    const registered: string[] = [];
    for (const tool of tools) {
      await registry.register({
        organizationId,
        slug: tool.name,
        name: tool.name,
        description: tool.description ?? `MCP tool from ${server.name}`,
        type: 'TOOL',
        inputSchema: tool.inputSchema,
        outputSchema: {},
        requiredPermissions: [...tool.requiredPermissions, ...server.allowedPermissions],
        allowedChannels: ['AGENT'],
        timeoutMs: 30_000,
        visibility: 'ORGANIZATION',
        ownerId,
        metadata: { mcpServerId: serverId, mcpTool: tool.name },
        handler: (input, context) => {
          const callContext: McpCallContext = {
            organizationId: context.organizationId,
            principalId: context.principalId,
            permissions: context.permissions ?? [],
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          };
          return this.execute(organizationId, serverId, tool.name, input, callContext);
        },
      });
      registered.push(tool.name);
    }
    return registered;
  }

  async execute(
    organizationId: string,
    serverId: string,
    toolName: string,
    argumentsValue: unknown,
    context: McpCallContext,
  ): Promise<unknown> {
    const server = this.require(organizationId, serverId);
    if (context.organizationId !== organizationId)
      throw new ValidationError('MCP organization mismatch');
    const tool = this.listTools(organizationId, serverId).find(
      (candidate) => candidate.name === toolName,
    );
    if (tool === undefined) throw new ValidationError('MCP tool has not been discovered');
    const missing = [...server.allowedPermissions, ...tool.requiredPermissions].filter(
      (permission) => !context.permissions.includes(permission),
    );
    if (missing.length > 0) throw new ValidationError('MCP tool permission denied');
    const credential: McpCredential | (() => Promise<McpCredential | undefined>) | undefined =
      server.credentialResolver === undefined
        ? context.credential
        : () => server.credentialResolver?.(context) ?? Promise.resolve(undefined);
    return this.observedRequest('call', 'tools/call', server, context.signal, credential, {
      name: toolName,
      arguments: argumentsValue,
    });
  }

  async close(organizationId: string, serverId: string): Promise<void> {
    const key = `${organizationId}:${serverId}`;
    const transport = this.transports.get(key);
    if (transport !== undefined) {
      await transport.close();
      this.transports.delete(key);
    }
  }

  /**
   * Drops a broken or restarted remote transport without discarding the
   * registered server or its persisted discovery cache. The next operation
   * lazily creates a fresh transport, which keeps reconnection out of the
   * current failed request and avoids retrying non-idempotent tool calls.
   */
  async reconnect(organizationId: string, serverId: string): Promise<void> {
    await this.close(organizationId, serverId);
  }

  private require(organizationId: string, serverId: string) {
    const server = this.servers.get(`${organizationId}:${serverId}`);
    if (server === undefined) throw new ValidationError('MCP server not found');
    return server;
  }

  private cacheKey(organizationId: string, serverId: string): string {
    return `${this.cacheNamespace}:${organizationId}:${serverId}`;
  }

  private async observedRequest<T = unknown>(
    operation: McpObservation['operation'],
    method: string,
    server: McpServerConfig,
    signal?: AbortSignal,
    credential?: McpCredential | (() => Promise<McpCredential | undefined>),
    params: Record<string, unknown> = {},
    transform: (result: unknown) => T = (result) => result as T,
  ): Promise<T> {
    const started = performance.now();
    try {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const requestSignal =
        signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const resolvedCredential = typeof credential === 'function' ? await credential() : credential;
      const result = await this.transport(server).request(
        method,
        params,
        requestSignal,
        resolvedCredential,
      );
      const transformed = transform(result);
      this.observe?.({ operation, method, outcome: 'success', durationMs: elapsed(started) });
      return transformed;
    } catch (error) {
      this.observe?.({ operation, method, outcome: 'error', durationMs: elapsed(started) });
      throw error;
    }
  }
  private transport(server: McpServerConfig) {
    const key = `${server.organizationId}:${server.id}`;
    const existing = this.transports.get(key);
    if (existing !== undefined) return existing;
    const transport =
      server.transport === 'STREAMABLE_HTTP'
        ? new StreamableHttpTransport(server)
        : new StdioTransport(server);
    this.transports.set(key, transport);
    return transport;
  }
}

function elapsed(started: number): number {
  return Math.max(0, performance.now() - started);
}
