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
      expect(await service.listGroupMemberships(organization.id)).toHaveLength(1);
      expect(await service.listPrincipalRoles(organization.id)).toHaveLength(1);
      expect(await service.listPermissions(organization.id)).toHaveLength(1);
      expect(await service.listRolePermissions(organization.id)).toHaveLength(1);
      await expect(service.listPrincipalPermissions(organization.id, user.id)).resolves.toEqual([
        'user.manage',
      ]);
      await expect(service.revokePermission(organization.id, role.id, permission.id)).resolves.toBe(
        true,
      );
      await expect(service.unassignRole(organization.id, user.id, role.id)).resolves.toBe(true);
      await expect(
        service.removePrincipalFromGroup(organization.id, group.id, user.id),
      ).resolves.toBe(true);
      await expect(
        service.removePrincipalFromGroup(organization.id, group.id, user.id),
      ).resolves.toBe(false);
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

  it('updates users, groups, and roles with optimistic versioning', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const service = new IdentityAdministrationService(new IdentityStorage(adapter));
      const user = await service.createUser('organization-a', {
        username: 'ana',
        displayName: 'Ana',
      });
      const group = await service.createGroup('organization-a', { name: 'Developers' });
      const role = await service.createRole('organization-a', { name: 'Reviewer' });
      await expect(
        service.updateUser('organization-a', user.id, {
          displayName: 'Ana Silva',
          email: 'ANA@EXAMPLE.COM',
        }),
      ).resolves.toMatchObject({ displayName: 'Ana Silva', email: 'ana@example.com', version: 2 });
      await expect(
        service.updateGroup('organization-a', group.id, {
          name: 'Platform',
          description: 'Platform team',
        }),
      ).resolves.toMatchObject({ name: 'Platform', version: 2 });
      await expect(
        service.updateRole('organization-a', role.id, { name: 'Auditor' }),
      ).resolves.toMatchObject({ name: 'Auditor', version: 2 });
      await expect(
        service.updateUser('organization-b', user.id, { displayName: 'Nope' }),
      ).rejects.toThrow(/User not found/);
    } finally {
      await adapter.close();
    }
  });
});
