export interface AdminCommandRuntime {
  readonly request: (url: string, init?: RequestInit) => Promise<Response>;
  readonly output: (value: string) => void;
}

import { requiredCliRuntimeConfig } from './runtime-config.js';

const routes: Readonly<Record<string, string>> = {
  agent: 'agents',
  capability: 'capabilities',
  plugin: 'plugins',
};

function apiContext(): { baseUrl: string; organizationId: string; token: string } {
  const config = requiredCliRuntimeConfig();
  return {
    baseUrl: config.apiUrl.replace(/\/$/u, ''),
    organizationId: config.organizationId,
    token: config.accessToken,
  };
}

function endpoint(route: string): string {
  const context = apiContext();
  return `${context.baseUrl}/api/v1/organizations/${encodeURIComponent(context.organizationId)}/${route}`;
}

function mcpEndpoint(): string {
  const context = apiContext();
  return `${context.baseUrl}/mcp/${encodeURIComponent(context.organizationId)}`;
}

function mcpManagementEndpoint(serverId: string, action: string): string {
  const context = apiContext();
  return `${context.baseUrl}/mcp/servers/${encodeURIComponent(context.organizationId)}/${encodeURIComponent(serverId)}/${action}`;
}

async function call(
  runtime: AdminCommandRuntime,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
): Promise<void> {
  const context = apiContext();
  const response = await runtime.request(endpoint(route), {
    method,
    headers: {
      authorization: `Bearer ${context.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(`HandStack API request failed: HTTP ${String(response.status)}`);
  runtime.output(await response.text());
}

async function callMcpManagement(
  runtime: AdminCommandRuntime,
  method: 'POST',
  serverId: string,
  action: string,
): Promise<void> {
  const context = apiContext();
  const response = await runtime.request(mcpManagementEndpoint(serverId, action), {
    method,
    headers: { authorization: `Bearer ${context.token}` },
  });
  if (!response.ok)
    throw new Error(`HandStack API request failed: HTTP ${String(response.status)}`);
  runtime.output(await response.text());
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

/** Implements the organization-scoped CLI commands from the public specification. */
export async function executeAdminCommand(
  args: readonly string[],
  runtime: AdminCommandRuntime,
): Promise<void> {
  const [group, action] = args;
  if (group === 'user' && action === 'create') {
    const data = option(args, '--data');
    if (data === undefined) throw new Error('user create requires --data <json>');
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      throw new Error('--data must contain valid JSON');
    }
    await call(runtime, 'POST', 'identity/users', payload);
    return;
  }
  if (group === 'plugin' && action === 'install') {
    const data = option(args, '--data');
    if (data === undefined) throw new Error('plugin install requires --data <json>');
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      throw new Error('--data must contain valid JSON');
    }
    await call(runtime, 'POST', 'plugins', payload);
    return;
  }
  if (group === 'mcp' && action === 'reconnect') {
    const serverId = option(args, '--server');
    if (serverId === undefined || serverId.trim() === '')
      throw new Error('mcp reconnect requires --server <server-id>');
    await callMcpManagement(runtime, 'POST', serverId, 'reconnect');
    return;
  }
  if (
    (action === 'list' || action === undefined) &&
    group !== undefined &&
    routes[group] !== undefined
  ) {
    await call(runtime, 'GET', routes[group]);
    return;
  }
  if (group === 'mcp' && action === 'serve') {
    runtime.output(`${mcpEndpoint()} (use POST JSON-RPC with the configured access token)`);
    return;
  }
  throw new Error(
    'Usage: handstack user create --data <json> | handstack agent list | handstack capability list | handstack plugin list | handstack mcp serve | handstack mcp reconnect --server <server-id>',
  );
}
