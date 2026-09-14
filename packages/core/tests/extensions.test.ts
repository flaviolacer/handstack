import { describe, expect, it } from 'vitest';
import { ExtensionRegistry, type ExtensionProvider } from '../src/index.js';

const provider = (id: string): ExtensionProvider => ({
  id,
  type: 'policy',
  apiVersion: '1',
  capabilities: ['authorize'],
  configurationSchema: { type: 'object' },
  requiredPermissions: ['policy.manage'],
  health: () => Promise.resolve({ status: 'healthy' }),
});

describe('ExtensionRegistry', () => {
  it('resolves organization providers before global providers deterministically', () => {
    const registry = new ExtensionRegistry();
    registry.register({
      provider: provider('global'),
      priority: 100,
      mandatory: true,
      enabled: true,
    });
    registry.register({
      provider: provider('tenant'),
      organizationId: 'org-1',
      priority: 1,
      mandatory: true,
      enabled: true,
    });

    expect(registry.resolve('policy', 'org-1').map(({ provider: item }) => item.id)).toEqual([
      'tenant',
      'global',
    ]);
  });

  it('rejects duplicate registrations in the same scope', () => {
    const registry = new ExtensionRegistry();
    const registration = {
      provider: provider('core'),
      priority: 1,
      mandatory: true,
      enabled: true,
    } as const;
    registry.register(registration);
    expect(() => {
      registry.register(registration);
    }).toThrow('already registered');
  });
});
