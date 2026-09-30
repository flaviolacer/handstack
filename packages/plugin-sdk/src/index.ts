import { createHash } from 'node:crypto';
import { ValidationError } from '@handstack/shared';

export type PluginMode = 'trusted' | 'isolated';
export type PluginType =
  | 'provider'
  | 'tool'
  | 'mcp'
  | 'agent'
  | 'auth'
  | 'identity'
  | 'identity-provider'
  | 'provisioning'
  | 'guardrail'
  | 'evaluation'
  | 'compliance'
  | 'privacy'
  | 'data-lifecycle'
  | 'sandbox'
  | 'audit-export'
  | 'siem'
  | 'webhook-delivery'
  | 'incident-management'
  | 'workflow-node'
  | 'compensation'
  | 'rag-policy'
  | 'knowledge'
  | 'storage'
  | 'observability'
  | 'ui'
  | 'workflow';
export type PluginPermission =
  'network' | 'filesystem' | 'secrets' | 'database' | 'user_identity' | 'mcp' | 'models';

export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly handstack: {
    readonly apiVersion: string;
    readonly capabilities: readonly string[];
    readonly type?: PluginType;
    readonly permissions?: readonly PluginPermission[];
    readonly mode?: PluginMode;
  };
}

export type PluginUiExtensionKind =
  'settings-page' | 'admin-page' | 'chat-action' | 'message-renderer';

export interface PluginUiExtension {
  readonly id: string;
  readonly kind: PluginUiExtensionKind;
  readonly title: string;
  readonly route?: string;
  readonly permission: string;
  readonly capability: string;
}

export interface IdentityProviderRegistration {
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly configurationSchema: Readonly<Record<string, unknown>>;
  readonly permissions: readonly string[];
}

export function validateIdentityProviderRegistration(input: IdentityProviderRegistration): void {
  if (!/^[a-z][a-z0-9.-]{1,63}$/.test(input.providerId))
    throw new ValidationError('Identity provider id is invalid');
  if (input.displayName.trim() === '' || input.capabilities.length === 0)
    throw new ValidationError('Identity provider name and capabilities are required');
  if (Object.keys(input.configurationSchema).length === 0)
    throw new ValidationError('Identity provider configuration schema is required');
  if (
    input.permissions.length === 0 ||
    new Set(input.permissions).size !== input.permissions.length
  )
    throw new ValidationError('Identity provider permissions must be unique and non-empty');
}

export class IdentityProviderRegistry {
  private readonly providers = new Map<string, IdentityProviderRegistration>();

  register(provider: IdentityProviderRegistration): void {
    if (!/^[a-z][a-z0-9.-]{1,63}$/.test(provider.providerId))
      throw new ValidationError('Identity provider id is invalid');
    if (provider.displayName.trim() === '' || provider.capabilities.length === 0)
      throw new ValidationError('Identity provider name and capabilities are required');
    if (Object.keys(provider.configurationSchema).length === 0)
      throw new ValidationError('Identity provider configuration schema is required');
    if (provider.permissions.length === 0)
      throw new ValidationError('Identity provider permissions are required');
    if (this.providers.has(provider.providerId))
      throw new ValidationError('Identity provider is already registered');
    this.providers.set(provider.providerId, provider);
  }

  list(): readonly IdentityProviderRegistration[] {
    return [...this.providers.values()];
  }
}

export interface IdentityProviderConfiguration {
  readonly organizationId: string;
  readonly providerId: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface IdentityProviderConfigurationStore {
  get(organizationId: string, providerId: string): IdentityProviderConfiguration | undefined;
  set(configuration: IdentityProviderConfiguration): void;
  delete(organizationId: string, providerId: string): void;
}

export class InMemoryIdentityProviderConfigurationStore implements IdentityProviderConfigurationStore {
  private readonly configurations = new Map<string, IdentityProviderConfiguration>();

  get(organizationId: string, providerId: string): IdentityProviderConfiguration | undefined {
    return this.configurations.get(`${organizationId}:${providerId}`);
  }

  set(configuration: IdentityProviderConfiguration): void {
    if (
      configuration.organizationId.trim() === '' ||
      !/^[a-z][a-z0-9.-]{1,63}$/.test(configuration.providerId)
    )
      throw new ValidationError('Identity provider configuration scope is invalid');
    if (Object.keys(configuration.values).length === 0)
      throw new ValidationError('Identity provider configuration values are required');
    for (const [key, value] of Object.entries(configuration.values)) {
      if (
        /(password|secret|token|private.?key)/iu.test(key) &&
        (typeof value !== 'string' || !value.startsWith('secret://'))
      )
        throw new ValidationError(`Identity provider secret field ${key} must be a reference`);
    }
    this.configurations.set(`${configuration.organizationId}:${configuration.providerId}`, {
      ...configuration,
      values: { ...configuration.values },
    });
  }

  delete(organizationId: string, providerId: string): void {
    this.configurations.delete(`${organizationId}:${providerId}`);
  }
}

export interface PluginToolRegistration {
  readonly name: string;
  readonly handler: (input: unknown) => Promise<unknown>;
}

export interface ProviderRegistration {
  readonly providerId: string;
  readonly displayName: string;
  readonly kind: 'model' | 'embedding' | 'vector' | 'storage' | 'notification' | 'other';
  readonly capabilities: readonly string[];
  readonly configurationSchema: Readonly<Record<string, unknown>>;
}

export function validateProviderRegistration(input: ProviderRegistration): void {
  if (!/^[a-z][a-z0-9.-]{1,63}$/.test(input.providerId))
    throw new ValidationError('Provider id is invalid');
  if (input.displayName.trim() === '')
    throw new ValidationError('Provider display name is required');
  if (input.capabilities.length === 0)
    throw new ValidationError('Provider capabilities are required');
  if (Object.keys(input.configurationSchema).length === 0)
    throw new ValidationError('Provider configuration schema is required');
}

export interface CapabilityRegistration {
  readonly capabilityId: string;
  readonly version: string;
  readonly description: string;
  readonly permissions: readonly string[];
}

export function validateCapabilityRegistration(input: CapabilityRegistration): void {
  if (!/^[a-z][a-z0-9.-]{1,63}$/.test(input.capabilityId))
    throw new ValidationError('Capability id is invalid');
  if (!/^\d+\.\d+$/.test(input.version))
    throw new ValidationError('Capability version must be major.minor');
  if (input.description.trim() === '')
    throw new ValidationError('Capability description is required');
  if (
    input.permissions.length === 0 ||
    new Set(input.permissions).size !== input.permissions.length
  )
    throw new ValidationError('Capability permissions must be unique and non-empty');
}

export class PluginUiRegistry {
  private readonly extensions = new Map<string, PluginUiExtension>();

  register(extension: PluginUiExtension): void {
    if (!/^[a-z][a-z0-9.-]{1,63}$/.test(extension.id))
      throw new ValidationError('Plugin UI extension id is invalid');
    if (extension.title.trim() === '' || extension.permission.trim() === '')
      throw new ValidationError('Plugin UI extension title and permission are required');
    if (extension.capability.trim() === '')
      throw new ValidationError('Plugin UI extension capability is required');
    if (extension.route !== undefined && !extension.route.startsWith('/plugins/'))
      throw new ValidationError('Plugin UI routes must remain under /plugins/');
    if (this.extensions.has(extension.id))
      throw new ValidationError('Plugin UI extension is already registered');
    this.extensions.set(extension.id, extension);
  }

  list(kind?: PluginUiExtensionKind): readonly PluginUiExtension[] {
    return [...this.extensions.values()].filter(
      (extension) => kind === undefined || extension.kind === kind,
    );
  }

  listAuthorized(
    permissions: readonly string[],
    capability?: string,
  ): readonly PluginUiExtension[] {
    const allowed = new Set(permissions);
    return this.list().filter(
      (extension) =>
        allowed.has(extension.permission) &&
        (capability === undefined || extension.capability === capability),
    );
  }
}

export interface PluginRegistrationContext {
  readonly pluginName: string;
  readonly mode: PluginMode;
  /** Secrets are resolved by the host; plugins never receive the secret store. */
  readonly secrets: { get(reference: string): Promise<string | undefined> };
  readonly tools: { register(input: PluginToolRegistration): void };
  readonly providers: { register(input: ProviderRegistration): void };
  readonly capabilities: { register(input: CapabilityRegistration): Promise<unknown> };
  readonly ui: { register(input: PluginUiExtension): void };
  readonly identity: { register(input: IdentityProviderRegistration): void };
}

export interface PluginDefinition {
  readonly manifest: PluginManifest;
  readonly setup: (context: PluginRegistrationContext) => void | Promise<void>;
  readonly onInstall?: () => void | Promise<void>;
  readonly onEnable?: () => void | Promise<void>;
  readonly onDisable?: () => void | Promise<void>;
  readonly onUninstall?: () => void | Promise<void>;
  readonly onServerStart?: () => void | Promise<void>;
  readonly onServerStop?: () => void | Promise<void>;
  readonly onUserLogin?: (principalId: string) => void | Promise<void>;
  readonly beforeLLMCall?: (input: unknown) => unknown;
  readonly afterLLMCall?: (input: unknown) => unknown;
  readonly beforeToolCall?: (input: unknown) => unknown;
  readonly afterToolCall?: (input: unknown) => unknown;
  readonly beforeAgentRun?: (input: unknown) => unknown;
  readonly afterAgentRun?: (input: unknown) => unknown;
}

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  validateManifest(definition.manifest);
  if (typeof definition.setup !== 'function') throw new ValidationError('Plugin setup is required');
  return definition;
}

export interface PluginRecord {
  readonly manifest: PluginManifest;
  readonly checksum: string;
  readonly mode: PluginMode;
  readonly status: 'INSTALLED' | 'ENABLED' | 'DISABLED';
  readonly approvedPermissions: readonly PluginPermission[];
}

export interface PluginHostOptions {
  readonly approve: (manifest: PluginManifest) => Promise<readonly PluginPermission[]>;
  readonly resolveSecret?: (reference: string, pluginName: string) => Promise<string | undefined>;
  readonly registerCapabilities?: PluginRegistrationContext['capabilities'];
  readonly registerIdentityProvider?: (input: IdentityProviderRegistration) => void;
  readonly registerUiExtension?: (input: PluginUiExtension) => void;
  readonly registerTool?: (input: PluginToolRegistration) => void;
  readonly registerProvider?: (input: ProviderRegistration) => void;
  readonly isolatedRpc?: (
    plugin: PluginDefinition,
    context: PluginRegistrationContext,
    sourceBytes: Uint8Array,
  ) => Promise<void>;
}

export class PluginHost {
  private readonly records = new Map<string, PluginRecord>();
  private readonly definitions = new Map<string, PluginDefinition>();
  private readonly sources = new Map<string, Uint8Array>();

  constructor(private readonly options: PluginHostOptions) {}

  async install(
    definition: PluginDefinition,
    sourceBytes: Uint8Array | string,
  ): Promise<PluginRecord> {
    const manifest = definePlugin(definition).manifest;
    if (this.records.has(manifest.name)) throw new ValidationError('Plugin is already installed');
    const requested = new Set(manifest.handstack.permissions ?? []);
    const approved = [...new Set(await this.options.approve(manifest))];
    if (approved.some((permission) => !requested.has(permission)))
      throw new ValidationError('Approved plugin permission was not requested');
    const mode = manifest.handstack.mode ?? 'isolated';
    const record: PluginRecord = {
      manifest,
      checksum: checksum(sourceBytes),
      mode,
      status: 'INSTALLED',
      approvedPermissions: approved,
    };
    this.records.set(manifest.name, record);
    this.definitions.set(manifest.name, definition);
    this.sources.set(
      manifest.name,
      typeof sourceBytes === 'string'
        ? new TextEncoder().encode(sourceBytes)
        : new Uint8Array(sourceBytes),
    );
    await definition.onInstall?.();
    return record;
  }

  async enable(name: string): Promise<PluginRecord> {
    const record = this.require(name);
    if (record.status === 'ENABLED') return record;
    const definition = this.definitions.get(name);
    if (definition === undefined) throw new ValidationError('Plugin runtime is unavailable');
    const context = this.context(record);
    if (record.mode === 'isolated') {
      if (this.options.isolatedRpc === undefined)
        throw new ValidationError('isolated plugin runner is unavailable');
      const sourceBytes = this.sources.get(name);
      if (sourceBytes === undefined)
        throw new ValidationError('isolated plugin artifact is unavailable');
      await this.options.isolatedRpc(definition, context, new Uint8Array(sourceBytes));
    } else {
      await definition.setup(context);
    }
    await definition.onEnable?.();
    const enabled = { ...record, status: 'ENABLED' as const };
    this.records.set(name, enabled);
    return enabled;
  }

  async disable(name: string): Promise<PluginRecord> {
    const record = this.require(name);
    const definition = this.definitions.get(name);
    await definition?.onDisable?.();
    const disabled = { ...record, status: 'DISABLED' as const };
    this.records.set(name, disabled);
    return disabled;
  }

  async uninstall(name: string): Promise<void> {
    const definition = this.definitions.get(name);
    await definition?.onUninstall?.();
    this.definitions.delete(name);
    this.sources.delete(name);
    this.records.delete(name);
  }

  get(name: string): PluginRecord | undefined {
    return this.records.get(name);
  }
  list(): readonly PluginRecord[] {
    return [...this.records.values()];
  }

  private context(record: PluginRecord): PluginRegistrationContext {
    return {
      pluginName: record.manifest.name,
      mode: record.mode,
      secrets: {
        get: (reference) => {
          if (!record.approvedPermissions.includes('secrets'))
            return Promise.reject(new ValidationError('Plugin secrets permission is required'));
          if (reference.trim() === '')
            return Promise.reject(new ValidationError('Secret reference is required'));
          if (this.options.resolveSecret === undefined)
            return Promise.reject(new ValidationError('Plugin secret resolver is unavailable'));
          return this.options.resolveSecret(reference, record.manifest.name);
        },
      },
      tools: {
        register: this.options.registerTool ?? (() => undefined),
      },
      providers: {
        register: (input) => {
          validateProviderRegistration(input);
          (this.options.registerProvider ?? (() => undefined))(input);
        },
      },
      capabilities: {
        register: (input) => {
          validateCapabilityRegistration(input);
          return (
            this.options.registerCapabilities ?? {
              register: () => Promise.resolve(undefined),
            }
          ).register(input);
        },
      },
      ui: { register: this.options.registerUiExtension ?? (() => undefined) },
      identity: {
        register: (input) => {
          validateIdentityProviderRegistration(input);
          (this.options.registerIdentityProvider ?? (() => undefined))(input);
        },
      },
    };
  }

  private require(name: string): PluginRecord {
    const record = this.records.get(name);
    if (record === undefined) throw new ValidationError('Plugin is not installed');
    return record;
  }
}

export function checksum(value: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : Buffer.from(value))
    .digest('hex');
}

function validateManifest(manifest: PluginManifest): void {
  if (manifest.name.trim() === '' || manifest.version.trim() === '')
    throw new ValidationError('Plugin name and version are required');
  if (manifest.handstack.apiVersion.trim() === '' || manifest.handstack.capabilities.length === 0)
    throw new ValidationError('Plugin apiVersion and capabilities are required');
  const permissions = manifest.handstack.permissions ?? [];
  if (new Set(permissions).size !== permissions.length)
    throw new ValidationError('Plugin permissions must be unique');
}
