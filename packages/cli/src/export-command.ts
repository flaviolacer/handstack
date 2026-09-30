import { stringify } from 'yaml';
import { requiredCliRuntimeConfig } from './runtime-config.js';

export interface ExportCommandRuntime {
  readonly write: (path: string, content: string) => Promise<void>;
  readonly request: (url: string, init: RequestInit) => Promise<Response>;
  readonly output: (value: string) => void;
}

const resources = {
  Agent: 'agents',
  Model: 'models',
  Provider: 'providers',
  Group: 'groups',
  Budget: 'budgets',
  RoutingPolicy: 'routing-policies',
  Plugin: 'plugins',
  Policy: 'policies',
  Capability: 'capabilities',
} as const;

type ResourceKind = keyof typeof resources;

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith('-')) throw new Error(`${name} is required`);
  return value;
}

function selectedResources(args: readonly string[]): readonly ResourceKind[] {
  const raw: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--resource') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error('--resource is required');
      raw.push(value);
      index += 1;
    }
  }
  const values =
    raw.length === 0 ? Object.keys(resources) : raw.flatMap((value) => value.split(','));
  if (values.some((value) => !(value in resources))) {
    throw new Error(
      `Unsupported export resource: ${values.find((value) => !(value in resources)) ?? ''}`,
    );
  }
  return values as ResourceKind[];
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (['id', 'tenantId', 'organizationId', 'version', 'createdAt', 'updatedAt'].includes(key))
      continue;
    if (/secret|token|credential|password/i.test(key)) continue;
    result[key] = sanitize(nested);
  }
  return result;
}

export async function executeExportCommand(
  args: readonly string[],
  runtime: ExportCommandRuntime,
): Promise<void> {
  if (args[0] !== 'export')
    throw new Error('Usage: handstack export -o <manifest.yaml> [--resource Agent,Model]');
  const outputPath = option(args, '-o');
  const { apiUrl: baseUrl, organizationId, accessToken } = requiredCliRuntimeConfig();
  const manifests: Record<string, unknown>[] = [];
  for (const kind of selectedResources(args)) {
    const response = await runtime.request(
      `${baseUrl.replace(/\/$/u, '')}/api/v1/organizations/${encodeURIComponent(organizationId)}/${resources[kind]}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) throw new Error(`Failed to export ${kind}: HTTP ${String(response.status)}`);
    const body = (await response.json()) as { readonly items?: unknown[] } | unknown[];
    const items = Array.isArray(body) ? body : (body.items ?? []);
    for (const item of items) {
      const clean = sanitize(item);
      const metadataName =
        typeof clean === 'object' &&
        clean !== null &&
        'slug' in clean &&
        typeof clean.slug === 'string'
          ? clean.slug
          : kind.toLowerCase();
      manifests.push({
        apiVersion: 'handstack.io/v1',
        kind,
        metadata: { name: metadataName },
        spec: clean,
      });
    }
  }
  await runtime.write(outputPath, stringify(manifests));
  runtime.output(
    `Configuration export written: ${outputPath} (${String(manifests.length)} resources)`,
  );
}
