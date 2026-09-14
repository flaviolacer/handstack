export interface IdentityPluginManifest {
  readonly id: string;
  readonly apiVersion: string;
  readonly permissions: readonly string[];
  readonly configurationSchema: Readonly<Record<string, unknown>>;
  readonly capabilities: readonly string[];
}

export interface IdentityPluginContractProbe {
  readonly validateTenantIsolation: () => Promise<boolean>;
  readonly validateTimeout: () => Promise<boolean>;
  readonly validateFailClosed: () => Promise<boolean>;
  readonly validateSecretLeakage: () => Promise<boolean>;
  readonly validateProtocol?: () => Promise<boolean>;
}

export interface IdentityPluginContractReport {
  readonly pluginId: string;
  readonly checks: readonly string[];
  readonly capabilities: readonly string[];
}

export class PluginContractError extends Error {
  constructor(
    readonly check: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginContractError';
  }
}

function requireValue(condition: unknown, check: string, message: string): asserts condition {
  if (!condition) throw new PluginContractError(check, message);
}

function validateStringList(value: unknown, check: string, message: string): void {
  requireValue(
    Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === 'string' && item.length > 0),
    check,
    message,
  );
}

function validateManifest(manifest: IdentityPluginManifest): void {
  requireValue(typeof manifest === 'object', 'manifest', 'manifest is required');
  requireValue(typeof manifest.id === 'string', 'manifest', 'plugin id is required');
  requireValue(
    /^[a-z][a-z0-9.-]+$/.test(manifest.id),
    'manifest',
    'plugin id must be stable and lowercase',
  );
  requireValue(
    /^\d+\.\d+$/.test(manifest.apiVersion),
    'apiVersion',
    'apiVersion must be major.minor',
  );
  validateStringList(
    manifest.permissions,
    'permissions',
    'plugins must declare non-empty string permissions',
  );
  requireValue(
    typeof manifest.configurationSchema === 'object' &&
      Object.keys(manifest.configurationSchema).length > 0,
    'configurationSchema',
    'configuration schema is required',
  );
  validateStringList(
    manifest.capabilities,
    'capabilities',
    'plugins must declare non-empty string capabilities',
  );
}

export async function verifyIdentityPluginContract(
  manifest: IdentityPluginManifest,
  probe: IdentityPluginContractProbe,
): Promise<IdentityPluginContractReport> {
  validateManifest(manifest);
  requireValue(typeof probe === 'object', 'probe', 'contract probe is required');
  const requiredProbeNames = [
    'validateTenantIsolation',
    'validateTimeout',
    'validateFailClosed',
    'validateSecretLeakage',
  ] as const;
  for (const name of requiredProbeNames) {
    requireValue(typeof probe[name] === 'function', name, `${name} probe is required`);
  }
  if (probe.validateProtocol !== undefined) {
    requireValue(
      typeof probe.validateProtocol === 'function',
      'protocol',
      'protocol probe must be callable',
    );
  }
  const checks = ['manifest', 'apiVersion', 'permissions', 'configurationSchema', 'capabilities'];
  const required: readonly [string, () => Promise<boolean>][] = [
    ['tenantIsolation', probe.validateTenantIsolation],
    ['timeout', probe.validateTimeout],
    ['failClosed', probe.validateFailClosed],
    ['secretLeakage', probe.validateSecretLeakage],
  ];
  for (const [name, check] of required) {
    try {
      requireValue(await check(), name, `${name} contract failed`);
    } catch (error) {
      if (error instanceof PluginContractError) throw error;
      throw new PluginContractError(name, `${name} contract failed`);
    }
  }
  checks.push(...required.map(([name]) => name));
  if (probe.validateProtocol !== undefined) {
    try {
      requireValue(await probe.validateProtocol(), 'protocol', 'protocol contract failed');
    } catch (error) {
      if (error instanceof PluginContractError) throw error;
      throw new PluginContractError('protocol', 'protocol contract failed');
    }
    checks.push('protocol');
  }
  return { pluginId: manifest.id, checks, capabilities: [...manifest.capabilities] };
}

export const identityPluginContractSuites = [
  'oidc-callback',
  'state-nonce',
  'pkce',
  'saml-assertion',
  'ldap-connection',
  'scim-users',
  'scim-groups',
  'jit-provisioning',
  'group-mapping',
  'attribute-mapping',
  'deprovisioning',
  'session-revocation',
  'multi-tenant-isolation',
  'secret-leakage-prevention',
] as const;

export type IdentityPluginContractSuite = (typeof identityPluginContractSuites)[number];

export const officialPluginContractSuites = [
  'policy-provider',
  'guardrail-provider',
  'evaluation-provider',
  'privacy-data-lifecycle',
  'sandbox-provider',
  'audit-sink-siem-exporter',
  'knowledge-connector-rag-policy',
  'workflow-node-compensation',
  'webhook-transport',
  'incident-management-status-page',
] as const;

export type OfficialPluginContractSuite = (typeof officialPluginContractSuites)[number];

export function assertOfficialPluginContractCoverage(
  declared: readonly string[],
): readonly OfficialPluginContractSuite[] {
  const missing = officialPluginContractSuites.filter((suite) => !declared.includes(suite));
  if (missing.length > 0) {
    throw new PluginContractError(
      'specialized-suites',
      `Missing plugin contract suites: ${missing.join(', ')}`,
    );
  }
  return [...officialPluginContractSuites];
}

export interface OfficialPluginImplementation {
  readonly packageName: string;
  readonly builtIn: boolean;
}

export const officialPluginImplementations: Readonly<
  Record<OfficialPluginContractSuite, OfficialPluginImplementation>
> = {
  'policy-provider': { packageName: 'packages/policy', builtIn: true },
  'guardrail-provider': { packageName: 'packages/policy', builtIn: true },
  'evaluation-provider': { packageName: 'packages/evaluation', builtIn: true },
  'privacy-data-lifecycle': { packageName: 'packages/privacy', builtIn: true },
  'sandbox-provider': { packageName: 'packages/sandbox', builtIn: true },
  'audit-sink-siem-exporter': { packageName: 'packages/observability-exporters', builtIn: true },
  'knowledge-connector-rag-policy': { packageName: 'packages/knowledge', builtIn: true },
  'workflow-node-compensation': { packageName: 'packages/workflows', builtIn: true },
  'webhook-transport': { packageName: 'packages/webhooks', builtIn: true },
  'incident-management-status-page': { packageName: 'packages/incidents', builtIn: true },
};

export function assertOfficialBuiltInImplementations(): Readonly<
  Record<OfficialPluginContractSuite, OfficialPluginImplementation>
> {
  for (const suite of officialPluginContractSuites) {
    const implementation = officialPluginImplementations[suite];
    if (!implementation.builtIn || implementation.packageName.length === 0) {
      throw new PluginContractError(
        'built-in-implementation',
        `Missing official built-in implementation for ${suite}`,
      );
    }
  }
  return officialPluginImplementations;
}

export interface OfficialPluginImplementationResolver {
  hasPackage(packageName: string): boolean;
}

export function verifyOfficialBuiltInImplementations(
  resolver: OfficialPluginImplementationResolver,
): Readonly<Record<OfficialPluginContractSuite, OfficialPluginImplementation>> {
  const implementations = assertOfficialBuiltInImplementations();
  for (const suite of officialPluginContractSuites) {
    if (!resolver.hasPackage(implementations[suite].packageName)) {
      throw new PluginContractError(
        'built-in-implementation',
        `Built-in package is unavailable for ${suite}`,
      );
    }
  }
  return implementations;
}
