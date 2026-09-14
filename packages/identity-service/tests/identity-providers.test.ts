import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { IdentityStorage } from '@handstack/identity-storage';
import { describe, expect, it } from 'vitest';
import {
  IdentityAdministrationService,
  IdentityProviderAdministrationService,
} from '../src/index.js';

const oidcConfiguration = {
  issuer: 'https://identity.example.com',
  clientId: 'handstack-client',
  redirectUri: 'https://handstack.example.com/auth/oidc/callback',
  scopes: ['openid', 'profile', 'email'],
} as const;

describe('identity provider administration', () => {
  it('persists multiple tenant-isolated providers without secret material', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const service = new IdentityProviderAdministrationService(new IdentityStorage(adapter));
      const first = await service.create('organization-a', {
        id: 'provider-a',
        pluginId: '@handstack/plugin-oidc',
        name: 'Employees',
        slug: 'employees',
        priority: 10,
        configuration: oidcConfiguration,
        clientSecretReference: 'secret://identity/provider-a/client-secret',
      });
      await service.create('organization-a', {
        id: 'provider-b',
        pluginId: '@handstack/plugin-oidc',
        name: 'Partners',
        slug: 'partners',
        priority: 20,
        configuration: { ...oidcConfiguration, clientId: 'partners-client' },
      });
      await service.create('organization-b', {
        id: 'provider-other-tenant',
        pluginId: '@handstack/plugin-oidc',
        name: 'Employees',
        slug: 'employees',
        configuration: oidcConfiguration,
      });

      expect((await service.list('organization-a')).map((provider) => provider.slug)).toEqual([
        'employees',
        'partners',
      ]);
      expect(await service.list('organization-b')).toHaveLength(1);
      expect(JSON.stringify(first)).not.toContain('actual-client-secret');
      await expect(
        service.create('organization-a', {
          pluginId: '@handstack/plugin-oidc',
          name: 'Duplicate',
          slug: 'employees',
          configuration: oidcConfiguration,
        }),
      ).rejects.toThrow('already exists');
      expect(() =>
        service.create('organization-a', {
          pluginId: '@handstack/plugin-oidc',
          name: 'Leaky',
          slug: 'leaky',
          configuration: {
            ...oidcConfiguration,
            clientSecret: 'actual-client-secret',
          } as typeof oidcConfiguration,
        }),
      ).toThrow('secret material');
      await service.setEnabled('organization-a', first.id, false);
      await expect(service.findEnabled('organization-a', 'employees')).rejects.toThrow('disabled');
      const auditEvents = (
        await new IdentityStorage(adapter)
          .forOrganization('organization-a')
          .auditEvents.list({ limit: 20 })
      ).items;
      expect(auditEvents.map((event) => event.eventType)).toContain('IDENTITY_PROVIDER_DISABLED');
      expect(JSON.stringify(auditEvents)).not.toContain('actual-client-secret');
    } finally {
      await adapter.close();
    }
  });

  it('requires explicit verified-email linking or JIT provisioning', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const storage = new IdentityStorage(adapter);
      const users = new IdentityAdministrationService(storage);
      const providers = new IdentityProviderAdministrationService(storage);
      const existing = await users.createUser('organization-a', {
        id: 'existing-user',
        username: 'ana.silva',
        displayName: 'Ana Silva',
        email: 'ana@example.com',
      });
      const locked = await providers.create('organization-a', {
        id: 'locked-provider',
        pluginId: '@handstack/plugin-oidc',
        name: 'Locked',
        slug: 'locked',
        configuration: oidcConfiguration,
      });
      await expect(
        providers.resolvePrincipal({
          organizationId: 'organization-a',
          providerId: locked.id,
          subject: 'subject-locked',
          claims: { email: 'ana@example.com', email_verified: true },
        }),
      ).rejects.toThrow('not permitted');

      const linking = await providers.create('organization-a', {
        id: 'linking-provider',
        pluginId: '@handstack/plugin-oidc',
        name: 'Linking',
        slug: 'linking',
        configuration: oidcConfiguration,
        loginPolicy: { accountLinking: 'VERIFIED_EMAIL' },
      });
      await expect(
        providers.resolvePrincipal({
          organizationId: 'organization-a',
          providerId: linking.id,
          subject: 'unverified-subject',
          claims: { email: 'ana@example.com', email_verified: false },
        }),
      ).rejects.toThrow('not permitted');
      await expect(
        providers.resolvePrincipal({
          organizationId: 'organization-a',
          providerId: linking.id,
          subject: 'verified-subject',
          claims: { email: 'ANA@example.com', email_verified: true },
        }),
      ).resolves.toBe(existing.id);

      const jit = await providers.create('organization-a', {
        id: 'jit-provider',
        pluginId: '@handstack/plugin-oidc',
        name: 'JIT',
        slug: 'jit',
        configuration: oidcConfiguration,
        provisioningPolicy: { jitEnabled: true },
      });
      const provisionedId = await providers.resolvePrincipal({
        organizationId: 'organization-a',
        providerId: jit.id,
        subject: 'new-subject',
        claims: {
          preferred_username: 'new.user',
          name: 'New User',
          email: 'new.user@example.com',
        },
      });
      await expect(
        storage.forOrganization('organization-a').users.findById(provisionedId),
      ).resolves.toMatchObject({ username: 'new.user', displayName: 'New User' });

      const mappedGroup = await users.createGroup('organization-a', { name: 'OIDC engineers' });
      const manualGroup = await users.createGroup('organization-a', { name: 'Manual access' });
      const mappedRole = await users.createRole('organization-a', { name: 'OIDC reviewer' });
      await users.addPrincipalToGroup('organization-a', manualGroup.id, provisionedId);
      await providers.setMappings('organization-a', jit.id, [
        {
          sourceClaim: 'groups',
          sourceValue: 'engineering',
          targetType: 'GROUP',
          targetId: mappedGroup.id,
        },
        {
          sourceClaim: 'groups',
          sourceValue: 'reviewers',
          targetType: 'ROLE',
          targetId: mappedRole.id,
        },
      ]);
      await providers.reconcileMappings('organization-a', jit.id, provisionedId, {
        groups: ['engineering', 'reviewers'],
      });
      expect(
        (await storage.forOrganization('organization-a').groupMemberships.list({ limit: 20 }))
          .items,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ groupId: mappedGroup.id, principalId: provisionedId }),
          expect.objectContaining({ groupId: manualGroup.id, principalId: provisionedId }),
        ]),
      );
      expect(
        (await storage.forOrganization('organization-a').principalRoles.list({ limit: 20 })).items,
      ).toContainEqual(
        expect.objectContaining({ roleId: mappedRole.id, principalId: provisionedId }),
      );
      await providers.reconcileMappings('organization-a', jit.id, provisionedId, { groups: [] });
      const remainingGroups = (
        await storage.forOrganization('organization-a').groupMemberships.list({ limit: 20 })
      ).items;
      expect(remainingGroups.some(({ groupId }) => groupId === mappedGroup.id)).toBe(false);
      expect(remainingGroups.some(({ groupId }) => groupId === manualGroup.id)).toBe(true);
      expect(
        (await storage.forOrganization('organization-a').principalRoles.list({ limit: 20 })).items,
      ).toHaveLength(0);

      await providers.setLoginPolicy('organization-a', {
        mode: 'SPECIFIC_IDP_REQUIRED',
        requiredProviderId: linking.id,
      });
      await expect(providers.assertProviderAllowed('organization-a', jit.id)).rejects.toThrow(
        'different identity provider',
      );
      await expect(
        providers.assertProviderAllowed('organization-a', linking.id),
      ).resolves.toBeUndefined();
    } finally {
      await adapter.close();
    }
  });
});
