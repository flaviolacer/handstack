import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import type { User } from '@handstack/identity';
import { IdentityStorage } from '../src/index.js';
import { identityStorageSchema } from '../src/index.js';
import { describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

function user(organizationId: string, id: string): User {
  const timestamp = new Date('2026-09-01T12:00:00.000Z');
  return {
    id,
    tenantId: organizationId,
    organizationId,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    type: 'USER',
    status: 'ACTIVE',
    displayName: 'Ana',
    username: 'ana',
    normalizedUsername: 'ana',
  };
}

describe('identity storage', () => {
  it('persists identity data through the canonical adapter with tenant isolation', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const storage = new IdentityStorage(adapter);
      await storage
        .forOrganization('organization-a')
        .users.insert(user('organization-a', 'user-a'));

      await expect(
        storage.forOrganization('organization-b').users.findById('user-a'),
      ).resolves.toBeUndefined();
      await expect(
        storage.forOrganization('organization-a').users.findById('user-a'),
      ).resolves.toMatchObject({
        organizationId: 'organization-a',
        normalizedUsername: 'ana',
      });
      expect(() =>
        storage.forOrganization('organization-a').users.insert(user('organization-b', 'user-b')),
      ).toThrow(/different organization/);
    } finally {
      await adapter.close();
    }
  });

  it('rolls back identity writes atomically', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const storage = new IdentityStorage(adapter);
      await expect(
        storage.run('organization-a', async (stores) => {
          await stores.users.insert(user('organization-a', 'rolled-back-user'));
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      await expect(
        storage.forOrganization('organization-a').users.findById('rolled-back-user'),
      ).resolves.toBeUndefined();
    } finally {
      await adapter.close();
    }
  });

  it('keeps the versioned repository manifest stable and reopens every M2 namespace', async () => {
    expect(identityStorageSchema).toEqual({
      version: 1,
      repositories: {
        organizations: 'identity-organizations',
        principals: 'identity-principals',
        users: 'identity-users',
        organizationMemberships: 'identity-organization-memberships',
        organizationSettings: 'identity-organization-settings',
        groups: 'identity-groups',
        groupMemberships: 'identity-group-memberships',
        externalIdentities: 'identity-external-identities',
        identityProviders: 'identity-providers',
        loginPolicies: 'identity-login-policies',
        breakGlassAccounts: 'identity-break-glass-accounts',
        identityMappings: 'identity-mappings',
        identityMappingGrants: 'identity-mapping-grants',
        auditEvents: 'identity-audit-events',
        roles: 'identity-roles',
        permissions: 'identity-permissions',
        rolePermissions: 'identity-role-permissions',
        principalRoles: 'identity-principal-roles',
        credentials: 'auth-local-credentials',
        sessions: 'auth-sessions',
        apiKeys: 'auth-api-keys',
        oidcTransactions: 'auth-oidc-transactions',
      },
    });

    const location = resolve(
      `identity-upgrade-${String(process.pid)}-${String(Date.now())}.sqlite`,
    );
    const config = defineConfig({ database: { adapter: 'sqlite', url: `file:${location}` } });
    const organizationId = 'upgrade-organization';
    const timestamp = new Date('2026-09-01T12:00:00.000Z');
    const entity = (id: string) => ({
      id,
      tenantId: organizationId,
      organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const first = createDatabaseAdapter(config);
    await first.initialize();
    try {
      const storage = new IdentityStorage(first);
      await storage.organizations.insert({
        ...entity('upgrade-organization'),
        name: 'Upgrade Organization',
        slug: 'upgrade-organization',
        status: 'ACTIVE',
      });
      const stores = storage.forOrganization(organizationId);
      await stores.users.insert(user(organizationId, 'persisted-user'));
      await stores.identityProviders.insert({
        ...entity('persisted-provider'),
        pluginId: 'generic-oidc',
        name: 'Persisted provider',
        slug: 'persisted-provider',
        type: 'OIDC',
        enabled: true,
        priority: 100,
        configuration: {
          issuer: 'https://identity.example.test',
          clientId: 'handstack',
          redirectUri: 'https://handstack.example.test/callback',
          scopes: ['openid'],
        },
        loginPolicy: { accountLinking: 'DISABLED' },
        provisioningPolicy: { jitEnabled: false },
        mappingPolicy: {
          usernameClaim: 'preferred_username',
          displayNameClaim: 'name',
          emailClaim: 'email',
        },
      });
      await stores.sessions.insert({
        ...entity('persisted-session'),
        principalId: 'persisted-user',
        refreshTokenHash: 'hash',
        refreshTokenFamilyId: 'family',
        expiresAt: timestamp,
        lastUsedAt: timestamp,
      });
    } finally {
      await first.close();
    }

    const reopened = createDatabaseAdapter(config);
    await reopened.initialize();
    try {
      const storage = new IdentityStorage(reopened);
      await expect(
        storage.organizations.findById(organizationId, organizationId),
      ).resolves.toMatchObject({
        slug: 'upgrade-organization',
      });
      const stores = storage.forOrganization(organizationId);
      await expect(stores.users.findById('persisted-user')).resolves.toMatchObject({
        normalizedUsername: 'ana',
      });
      await expect(stores.identityProviders.findById('persisted-provider')).resolves.toMatchObject({
        pluginId: 'generic-oidc',
        mappingPolicy: { emailClaim: 'email' },
      });
      await expect(stores.sessions.findById('persisted-session')).resolves.toMatchObject({
        principalId: 'persisted-user',
        refreshTokenFamilyId: 'family',
      });
    } finally {
      await reopened.close();
      await rm(location, { force: true });
    }
  });
});
