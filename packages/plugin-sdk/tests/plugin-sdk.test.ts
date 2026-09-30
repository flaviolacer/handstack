import { describe, expect, it } from 'vitest';
import {
  IdentityProviderRegistry,
  InMemoryIdentityProviderConfigurationStore,
  PluginHost,
  PluginUiRegistry,
  definePlugin,
  checksum,
  validateProviderRegistration,
  type PluginDefinition,
} from '../src/index.js';

const definition: PluginDefinition = definePlugin({
  manifest: {
    name: '@handstack/plugin-test',
    version: '1.0.0',
    handstack: {
      apiVersion: '1',
      capabilities: ['tools'],
      permissions: ['network'],
      mode: 'trusted',
    },
  },
  setup: ({ tools }) => {
    tools.register({ name: 'echo', handler: (input) => Promise.resolve(input) });
  },
});

describe('Plugin SDK', () => {
  it('brokers tenant-scoped secrets only to plugins with the secrets permission', async () => {
    let resolved: string | undefined;
    const host = new PluginHost({
      approve: () => Promise.resolve(['secrets']),
      resolveSecret: (reference, pluginName) => {
        expect(reference).toBe('secret://provider/token');
        expect(pluginName).toBe('@handstack/secret-plugin');
        return Promise.resolve('resolved-value');
      },
    });
    const secretDefinition = definePlugin({
      ...definition,
      manifest: {
        ...definition.manifest,
        name: '@handstack/secret-plugin',
        handstack: { ...definition.manifest.handstack, permissions: ['secrets'] },
      },
      setup: async ({ secrets }) => {
        resolved = await secrets.get('secret://provider/token');
      },
    });
    await host.install(secretDefinition, 'secret-plugin');
    await host.enable('@handstack/secret-plugin');
    expect(resolved).toBe('resolved-value');

    const deniedHost = new PluginHost({ approve: () => Promise.resolve([]) });
    const deniedDefinition = definePlugin({
      ...secretDefinition,
      manifest: { ...secretDefinition.manifest, name: '@handstack/denied-secret-plugin' },
      setup: async ({ secrets }) => {
        await secrets.get('secret://provider/token');
      },
    });
    await deniedHost.install(deniedDefinition, 'denied-secret-plugin');
    await expect(deniedHost.enable('@handstack/denied-secret-plugin')).rejects.toThrow(
      /secrets permission/,
    );
  });

  it('stores identity configuration by organization and rejects inline secrets', () => {
    const store = new InMemoryIdentityProviderConfigurationStore();
    store.set({
      organizationId: 'org-a',
      providerId: 'generic-saml',
      values: { issuer: 'https://idp.test', clientSecret: 'secret://vault/idp' },
    });
    expect(store.get('org-a', 'generic-saml')?.values.issuer).toBe('https://idp.test');
    expect(store.get('org-b', 'generic-saml')).toBeUndefined();
    expect(() => {
      store.set({
        organizationId: 'org-a',
        providerId: 'generic-saml',
        values: { clientSecret: 'inline' },
      });
    }).toThrow(/reference/);
  });

  it('registers identity providers with explicit capabilities and permissions', () => {
    const registry = new IdentityProviderRegistry();
    registry.register({
      providerId: 'generic-saml',
      displayName: 'Generic SAML',
      capabilities: ['identity.saml'],
      configurationSchema: { type: 'object' },
      permissions: ['user_identity'],
    });
    expect(registry.list()).toHaveLength(1);
    expect(() => {
      registry.register({
        providerId: 'generic-saml',
        displayName: 'Duplicate',
        capabilities: ['identity.saml'],
        configurationSchema: { type: 'object' },
        permissions: ['user_identity'],
      });
    }).toThrow(/already registered/);
    expect(() => {
      registry.register({
        providerId: 'broken',
        displayName: 'Broken',
        capabilities: [],
        configurationSchema: {},
        permissions: [],
      });
    }).toThrow(/capabilities/);
  });

  it('accepts vector providers as a governed extension point', () => {
    const registration = {
      providerId: 'qdrant',
      displayName: 'Qdrant Vector Store',
      kind: 'vector' as const,
      capabilities: ['vector.upsert', 'vector.search'],
      configurationSchema: { type: 'object' },
    };
    expect(() => {
      validateProviderRegistration(registration);
    }).not.toThrow();
  });

  it('forwards identity registration through the host boundary', async () => {
    const registrations: string[] = [];
    const host = new PluginHost({
      approve: () => Promise.resolve([]),
      registerIdentityProvider: (provider) => registrations.push(provider.providerId),
    });
    const definitionWithIdentity = definePlugin({
      ...definition,
      manifest: { ...definition.manifest, name: '@handstack/identity-plugin' },
      setup: ({ identity }) => {
        identity.register({
          providerId: 'generic-oidc',
          displayName: 'Generic OIDC',
          capabilities: ['identity.oidc'],
          configurationSchema: { type: 'object' },
          permissions: ['user_identity'],
        });
      },
    });
    await host.install(definitionWithIdentity, 'identity-plugin');
    await host.enable('@handstack/identity-plugin');
    expect(registrations).toEqual(['generic-oidc']);
  });

  it('rejects invalid identity provider metadata before the host callback', async () => {
    let calls = 0;
    const host = new PluginHost({
      approve: () => Promise.resolve([]),
      registerIdentityProvider: () => {
        calls += 1;
      },
    });
    const invalid = definePlugin({
      ...definition,
      manifest: { ...definition.manifest, name: '@handstack/invalid-identity' },
      setup: ({ identity }) => {
        identity.register({
          providerId: 'Bad ID',
          displayName: '',
          capabilities: [],
          configurationSchema: {},
          permissions: [],
        });
      },
    });
    const record = await host.install(invalid, 'invalid-identity');
    await expect(host.enable(record.manifest.name)).rejects.toThrow(
      /Identity provider id is invalid/,
    );
    expect(calls).toBe(0);
  });

  it('registers only typed, permissioned UI extension points under the plugin route', () => {
    const registry = new PluginUiRegistry();
    registry.register({
      id: 'identity-settings',
      kind: 'settings-page',
      title: 'Identity',
      route: '/plugins/idp/settings',
      permission: 'identity.manage',
      capability: 'identity.configuration',
    });
    expect(registry.list('settings-page')).toHaveLength(1);
    registry.register({
      id: 'admin-audit',
      kind: 'admin-page',
      title: 'Audit',
      permission: 'audit.read',
      capability: 'audit.view',
    });
    expect(registry.listAuthorized(['identity.manage'])).toHaveLength(1);
    expect(registry.listAuthorized(['audit.read'], 'audit.view')).toHaveLength(1);
    expect(() => {
      registry.register({
        id: 'identity-settings',
        kind: 'admin-page',
        title: 'Duplicate',
        permission: 'identity.manage',
        capability: 'identity.configuration',
      });
    }).toThrow(/already registered/);
    expect(() => {
      registry.register({
        id: 'unsafe',
        kind: 'admin-page',
        title: 'Unsafe',
        route: '/admin',
        permission: 'identity.manage',
        capability: 'identity.configuration',
      });
    }).toThrow(/routes/);
  });

  it('forwards UI registration through the host boundary', async () => {
    const registrations: string[] = [];
    const host = new PluginHost({
      approve: () => Promise.resolve([]),
      registerUiExtension: (extension) => registrations.push(extension.id),
    });
    const definitionWithUi = definePlugin({
      ...definition,
      manifest: { ...definition.manifest, name: '@handstack/ui-plugin' },
      setup: ({ ui }) => {
        ui.register({
          id: 'settings',
          kind: 'settings-page',
          title: 'Settings',
          permission: 'plugins.manage',
          capability: 'plugin.settings',
        });
      },
    });
    const record = await host.install(definitionWithUi, 'ui-plugin');
    await host.enable(record.manifest.name);
    expect(registrations).toEqual(['settings']);
  });

  it('forwards tool registration through the host boundary', async () => {
    const registrations: string[] = [];
    const host = new PluginHost({
      approve: () => Promise.resolve([]),
      registerTool: (tool) => registrations.push(tool.name),
    });
    const toolDefinition = definePlugin({
      ...definition,
      manifest: { ...definition.manifest, name: '@handstack/tool-plugin' },
      setup: ({ tools }) => {
        tools.register({ name: 'echo', handler: (input) => Promise.resolve(input) });
      },
    });
    const record = await host.install(toolDefinition, 'tool-plugin');
    await host.enable(record.manifest.name);
    expect(registrations).toEqual(['echo']);
  });

  it('forwards provider registration through the host boundary', async () => {
    const registrations: string[] = [];
    const host = new PluginHost({
      approve: () => Promise.resolve([]),
      registerProvider: (provider) => registrations.push(provider.providerId),
    });
    const providerDefinition = definePlugin({
      ...definition,
      manifest: { ...definition.manifest, name: '@handstack/provider-plugin' },
      setup: ({ providers }) => {
        providers.register({
          providerId: 'provider-a',
          displayName: 'Provider A',
          kind: 'model',
          capabilities: ['chat'],
          configurationSchema: { type: 'object' },
        });
      },
    });
    const record = await host.install(providerDefinition, 'provider-plugin');
    await host.enable(record.manifest.name);
    expect(registrations).toEqual(['provider-a']);
  });

  it('rejects invalid provider metadata before the host callback', async () => {
    let calls = 0;
    const host = new PluginHost({
      approve: () => Promise.resolve([]),
      registerProvider: () => {
        calls += 1;
      },
    });
    const invalid = definePlugin({
      ...definition,
      manifest: { ...definition.manifest, name: '@handstack/invalid-provider' },
      setup: ({ providers }) => {
        providers.register({
          providerId: 'Bad ID',
          displayName: '',
          kind: 'model',
          capabilities: [],
          configurationSchema: {},
        });
      },
    });
    const record = await host.install(invalid, 'invalid-provider');
    await expect(host.enable(record.manifest.name)).rejects.toThrow(/Provider id is invalid/);
    expect(calls).toBe(0);
  });

  it('forwards typed capability registration through the host boundary', async () => {
    const registrations: string[] = [];
    const host = new PluginHost({
      approve: () => Promise.resolve([]),
      registerCapabilities: {
        register: (capability) => {
          registrations.push(capability.capabilityId);
          return Promise.resolve(undefined);
        },
      },
    });
    const capabilityDefinition = definePlugin({
      ...definition,
      manifest: { ...definition.manifest, name: '@handstack/capability-plugin' },
      setup: async ({ capabilities }) => {
        await capabilities.register({
          capabilityId: 'capability.a',
          version: '1.0',
          description: 'A capability',
          permissions: ['models'],
        });
      },
    });
    const record = await host.install(capabilityDefinition, 'capability-plugin');
    await host.enable(record.manifest.name);
    expect(registrations).toEqual(['capability.a']);
  });

  it('rejects invalid capability metadata before the host callback', async () => {
    let calls = 0;
    const host = new PluginHost({
      approve: () => Promise.resolve([]),
      registerCapabilities: {
        register: () => {
          calls += 1;
          return Promise.resolve();
        },
      },
    });
    const invalid = definePlugin({
      ...definition,
      manifest: { ...definition.manifest, name: '@handstack/invalid-capability' },
      setup: async ({ capabilities }) => {
        await capabilities.register({
          capabilityId: 'Bad ID',
          version: 'v1',
          description: '',
          permissions: [],
        });
      },
    });
    const record = await host.install(invalid, 'invalid-capability');
    await expect(host.enable(record.manifest.name)).rejects.toThrow(/Capability id is invalid/);
    expect(calls).toBe(0);
  });

  it('validates manifest, records checksum and runs trusted lifecycle', async () => {
    const events: string[] = [];
    const host = new PluginHost({
      approve: () => Promise.resolve(['network']),
    });
    const record = await host.install(
      {
        ...definition,
        onInstall: () => {
          events.push('install');
        },
        onEnable: () => {
          events.push('enable');
        },
      },
      'plugin-bytes',
    );
    expect(record.checksum).toBe(checksum('plugin-bytes'));
    await host.enable(record.manifest.name);
    expect(host.get(record.manifest.name)?.status).toBe('ENABLED');
    expect(events).toEqual(['install', 'enable']);
  });

  it('fails closed for unapproved permissions and isolated runtime without RPC', async () => {
    const unapproved: PluginDefinition = {
      ...definition,
      manifest: {
        ...definition.manifest,
        name: '@handstack/unapproved',
        handstack: { ...definition.manifest.handstack, mode: 'isolated', permissions: ['secrets'] },
      },
    };
    const host = new PluginHost({ approve: () => Promise.resolve([]) });
    await expect(host.install(unapproved, 'x')).resolves.toMatchObject({ approvedPermissions: [] });
    await expect(host.enable('@handstack/unapproved')).rejects.toThrow(/isolated/);
    const denied = new PluginHost({ approve: () => Promise.resolve(['secrets']) });
    await expect(denied.install(unapproved, 'x')).resolves.toBeDefined();
  });

  it('passes the verified source artifact to an isolated RPC boundary', async () => {
    let received = '';
    const isolated: PluginDefinition = {
      ...definition,
      manifest: {
        ...definition.manifest,
        name: '@handstack/isolated-source',
        handstack: { ...definition.manifest.handstack, mode: 'isolated' },
      },
    };
    const host = new PluginHost({
      approve: () => Promise.resolve([]),
      isolatedRpc: (_plugin, context, sourceBytes) => {
        received = new TextDecoder().decode(sourceBytes);
        expect(context.mode).toBe('isolated');
        return Promise.resolve();
      },
    });
    await host.install(isolated, 'verified-source');
    await host.enable(isolated.manifest.name);
    expect(received).toBe('verified-source');
  });
});
