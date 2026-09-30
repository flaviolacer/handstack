import { parse } from 'yaml';
import { requiredCliRuntimeConfig } from './runtime-config.js';

export interface ApplyCommandRuntime {
  readonly read: (path: string) => Promise<string>;
  readonly output: (value: string) => void;
  readonly request?: (url: string, init: RequestInit) => Promise<Response>;
}

interface Manifest {
  readonly apiVersion?: unknown;
  readonly kind?: unknown;
  readonly metadata?: { readonly name?: unknown };
  readonly spec?: unknown;
}

const endpoints: Readonly<Record<string, string>> = {
  Agent: 'agents',
  Model: 'models',
  Provider: 'providers',
  Group: 'groups',
  Budget: 'budgets',
  RoutingPolicy: 'routing-policies',
  Plugin: 'plugins',
  Policy: 'policies',
  Capability: 'capabilities',
};

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith('-')) throw new Error(`${name} is required`);
  return value;
}

function manifests(value: unknown): Manifest[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.some((item) => typeof item !== 'object' || item === null)) {
    throw new Error('Manifest must contain one or more resource objects');
  }
  return values as Manifest[];
}

export async function executeApplyCommand(
  args: readonly string[],
  runtime: ApplyCommandRuntime,
): Promise<void> {
  if (args[0] !== 'apply') throw new Error('Usage: handstack apply -f <manifest.yaml>');
  const input = await runtime.read(option(args, '-f'));
  const resources = manifests(parse(input));
  const resourceKeys = new Set<string>();
  for (const resource of resources) {
    if (resource.apiVersion !== 'handstack.io/v1')
      throw new Error('Manifest apiVersion must be handstack.io/v1');
    if (typeof resource.kind !== 'string' || endpoints[resource.kind] === undefined) {
      throw new Error(`Unsupported apply resource: ${String(resource.kind)}`);
    }
    if (
      typeof resource.spec !== 'object' ||
      resource.spec === null ||
      Array.isArray(resource.spec)
    ) {
      throw new Error(`${resource.kind} spec must be an object`);
    }
    if (
      resource.metadata === undefined ||
      typeof resource.metadata.name !== 'string' ||
      resource.metadata.name.trim() === ''
    ) {
      throw new Error(`${resource.kind} metadata.name is required`);
    }
    const resourceKey = `${resource.kind}\u0000${resource.metadata.name.trim()}`;
    if (resourceKeys.has(resourceKey))
      throw new Error(`${resource.kind}/${resource.metadata.name} is duplicated`);
    resourceKeys.add(resourceKey);
  }
  const { apiUrl: baseUrl, organizationId, accessToken } = requiredCliRuntimeConfig();
  if (runtime.request === undefined) throw new Error('API request runtime is required');
  for (const resource of resources) {
    const kind = typeof resource.kind === 'string' ? resource.kind : 'unknown';
    const name = resource.metadata?.name as string;
    const endpoint = endpoints[kind] ?? '';
    const response = await runtime.request(
      `${baseUrl.replace(/\/$/u, '')}/api/v1/organizations/${encodeURIComponent(organizationId)}/${endpoint}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(resource.spec),
      },
    );
    if (!response.ok)
      throw new Error(`Failed to apply ${kind}/${name}: HTTP ${String(response.status)}`);
    runtime.output(`Applied ${kind}/${name}`);
  }
}
