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
  readonly credentialResolver?: (context: McpCallContext) => Promise<McpCredential | undefined>;
  readonly allowedPermissions: readonly string[];
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

  constructor(private readonly observe?: McpObservationSink) {}

  register(server: McpServerConfig): void {
    if (server.organizationId === '' || server.id === '')
      throw new ValidationError('MCP server organization and id are required');
    if (this.servers.has(`${server.organizationId}:${server.id}`))
      throw new ValidationError('MCP server already exists');
    this.servers.set(`${server.organizationId}:${server.id}`, server);
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
    this.tools.set(`${organizationId}:${serverId}`, discovered);
    return discovered;
  }

  listTools(organizationId: string, serverId: string): readonly McpTool[] {
    return this.tools.get(`${organizationId}:${serverId}`) ?? [];
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
    this.resources.set(`${organizationId}:${serverId}`, discovered);
    return discovered;
  }

  listResources(organizationId: string, serverId: string): readonly McpResource[] {
    return this.resources.get(`${organizationId}:${serverId}`) ?? [];
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
    this.prompts.set(`${organizationId}:${serverId}`, discovered);
    return discovered;
  }

  listPrompts(organizationId: string, serverId: string): readonly McpPrompt[] {
    return this.prompts.get(`${organizationId}:${serverId}`) ?? [];
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

  private require(organizationId: string, serverId: string) {
    const server = this.servers.get(`${organizationId}:${serverId}`);
    if (server === undefined) throw new ValidationError('MCP server not found');
    return server;
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
      const resolvedCredential = typeof credential === 'function' ? await credential() : credential;
      const result = await this.transport(server).request(
        method,
        params,
        signal,
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
