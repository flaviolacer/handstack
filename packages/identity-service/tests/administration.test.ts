import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { IdentityStorage } from '@handstack/identity-storage';
import { IdentityAdministrationService } from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('identity administration', () => {
  it('implements the M2 admin, group membership, and permission acceptance flow', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const service = new IdentityAdministrationService(new IdentityStorage(adapter));
      const organization = await service.createOrganization({
        id: 'organization-a',
        name: 'Acme',
        slug: 'acme',
      });
      const user = await service.createUser(organization.id, {
        id: 'user-a',
        username: 'Ana.Silva',
        displayName: 'Ana Silva',
      });
      const group = await service.createGroup(organization.id, {
        id: 'developers',
        name: 'Developers',
      });
      await service.addPrincipalToGroup(organization.id, group.id, user.id);

      await expect(
        service.authorize({
          organizationId: organization.id,
          principalId: user.id,
          permission: 'user.manage',
        }),
      ).resolves.toMatchObject({ allowed: false });

      const role = await service.createRole(organization.id, {
        id: 'org-admin',
        name: 'ORG_ADMIN',
      });
      const permission = await service.createPermission(
        organization.id,
        'user.manage',
        'user-manage',
      );
      await service.grantPermission(organization.id, role.id, permission.id);
      await service.assignRole(organization.id, user.id, role.id);

      await expect(
        service.authorize({
          organizationId: organization.id,
          principalId: user.id,
          permission: 'user.manage',
        }),
      ).resolves.toMatchObject({ allowed: true, policyIds: ['org-admin'] });
      await expect(
        service.authorize({
          organizationId: 'organization-b',
          principalId: user.id,
          permission: 'user.manage',
        }),
      ).resolves.toEqual({ allowed: false, reason: 'principal not found' });
    } finally {
      await adapter.close();
    }
  });

  it('rejects duplicate normalized usernames atomically', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const service = new IdentityAdministrationService(new IdentityStorage(adapter));
      await service.createUser('organization-a', {
        username: 'Ana.Silva',
        displayName: 'Ana',
      });
      await expect(
        service.createUser('organization-a', {
          username: '  ANA.SILVA ',
          displayName: 'Other Ana',
        }),
      ).rejects.toThrow(/username already exists/);
    } finally {
      await adapter.close();
    }
  });
});
