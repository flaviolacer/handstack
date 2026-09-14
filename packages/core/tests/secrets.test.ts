import { describe, expect, it, vi } from 'vitest';
import { scopedSecretResolver, type SecretProvider } from '../src/index.js';

describe('secret provider boundary', () => {
  it('gives plugins a scoped resolver without exposing the provider', async () => {
    const get = vi.fn<SecretProvider['get']>().mockResolvedValue('resolved-secret');
    const resolver = scopedSecretResolver({ get }, 'secret://identity/provider/client', {
      organizationId: 'organization-a',
      pluginId: '@handstack/plugin-oidc',
    });
    await expect(resolver()).resolves.toBe('resolved-secret');
    expect(get).toHaveBeenCalledWith('secret://identity/provider/client', {
      organizationId: 'organization-a',
      pluginId: '@handstack/plugin-oidc',
    });
  });
});
