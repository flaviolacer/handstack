import type {
  CapabilityExecutionContext,
  CapabilityExecutionEngine,
  CapabilityRegistry,
} from '@handstack/capabilities';
import { ValidationError } from '@handstack/shared';

export interface McpServerPrincipal {
  readonly organizationId: string;
  readonly subject: string;
  readonly permissions: readonly string[];
}

export interface McpServerRequestContext {
  readonly organizationId: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly principal?: McpServerPrincipal;
  readonly signal?: AbortSignal;
  readonly requestId?: string;
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

export interface McpServerAuth {
  authenticate(context: McpServerRequestContext): Promise<McpServerPrincipal | undefined>;
}

export interface McpObservation {
  readonly method: string;
  readonly outcome: 'success' | 'error';
  readonly durationMs: number;
}

export type McpObservationSink = (observation: McpObservation) => void;

export interface McpAdditionalTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly requiredPermissions?: readonly string[];
  readonly execute: (input: unknown, context: CapabilityExecutionContext) => Promise<unknown>;
}

export type McpAdditionalToolProvider = (
  principal: McpServerPrincipal,
) => Promise<readonly McpAdditionalTool[]>;

export interface McpJsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

const invalidRequest = -32600;
const methodNotFound = -32601;
const invalidParams = -32602;
const unauthorized = -32001;

export class McpServer {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly engine: CapabilityExecutionEngine,
    private readonly auth?: McpServerAuth,
    private readonly resources: readonly McpResource[] = [],
    private readonly prompts: readonly McpPrompt[] = [],
    private readonly observe?: McpObservationSink,
    private readonly additionalToolProvider?: McpAdditionalToolProvider,
  ) {}

  async handle(
    request: unknown,
    context: McpServerRequestContext,
  ): Promise<McpJsonRpcResponse | undefined> {
    const started = performance.now();
    let outcome: McpObservation['outcome'] = 'success';
    if (!isRequest(request)) {
      this.observe?.({
        method: 'invalid_request',
        outcome: 'error',
        durationMs: Math.max(0, performance.now() - started),
      });
      return response(null, undefined, {
        code: invalidRequest,
        message: 'Invalid JSON-RPC request',
      });
    }
    const id = request.id === undefined ? null : request.id;
    try {
      const principal = await this.authenticate(context);
      if (principal === undefined) {
        outcome = 'error';
        return response(id, undefined, {
          code: unauthorized,
          message: 'MCP authentication required',
        });
      }
      if (request.method === 'notifications/initialized') return undefined;
      if (request.method === 'initialize') {
        return response(id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'handstack-mcp', version: '0.0.0' },
        });
      }
      switch (request.method) {
        case 'tools/list':
          return response(id, { tools: await this.tools(principal) });
        case 'resources/list':
          return response(id, { resources: this.resources });
        case 'prompts/list':
          return response(id, { prompts: this.prompts });
        case 'tools/call':
          return response(id, await this.call(request.params, context, principal));
        default:
          outcome = 'error';
          return response(id, undefined, { code: methodNotFound, message: 'MCP method not found' });
      }
    } catch (error) {
      outcome = 'error';
      const message = error instanceof ValidationError ? error.message : 'MCP request failed';
      return response(id, undefined, { code: invalidParams, message });
    } finally {
      if (isRequest(request))
        this.observe?.({
          method: request.method,
          outcome,
          durationMs: Math.max(0, performance.now() - started),
        });
    }
  }

  private async authenticate(
    context: McpServerRequestContext,
  ): Promise<McpServerPrincipal | undefined> {
    if (context.principal !== undefined) {
      if (context.principal.organizationId !== context.organizationId)
        throw new ValidationError('MCP organization mismatch');
      return context.principal;
    }
    return this.auth?.authenticate(context);
  }

  private async tools(principal: McpServerPrincipal) {
    const permissions = new Set(principal.permissions);
    const registered = (await this.registry.list(principal.organizationId, 'MCP'))
      .filter((capability) => capability.published === true)
      .filter((capability) =>
        capability.requiredPermissions.every((permission) => permissions.has(permission)),
      )
      .map((capability) => ({
        name: capability.slug,
        description: capability.description,
        inputSchema: capability.inputSchema,
      }));
    const additional = (await this.additionalToolProvider?.(principal)) ?? [];
    return [
      ...registered,
      ...additional
        .filter((tool) =>
          (tool.requiredPermissions ?? []).every((permission) => permissions.has(permission)),
        )
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ];
  }

  private async call(
    params: Record<string, unknown> | undefined,
    context: McpServerRequestContext,
    principal: McpServerPrincipal,
  ) {
    if (params === undefined || typeof params.name !== 'string')
      throw new ValidationError('MCP tool name is required');
    const input = params.arguments;
    const executionContext: CapabilityExecutionContext = {
      organizationId: context.organizationId,
      principalId: principal.subject,
      channel: 'MCP',
      permissions: principal.permissions,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    };
    const additional = (await this.additionalToolProvider?.(principal)) ?? [];
    const additionalTool = additional.find((tool) => tool.name === params.name);
    if (additionalTool !== undefined) {
      const permissions = new Set(principal.permissions);
      if (
        !(additionalTool.requiredPermissions ?? []).every((permission) =>
          permissions.has(permission),
        )
      )
        throw new ValidationError('MCP tool permission is not granted');
      const result = await additionalTool.execute(input, executionContext);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    const result = await this.engine.execute(params.name, input, executionContext);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
}

function isRequest(value: unknown): value is McpJsonRpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === '2.0' && typeof record.method === 'string';
}

function response(
  id: string | number | null,
  result?: unknown,
  error?: { readonly code: number; readonly message: string },
): McpJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  };
}
