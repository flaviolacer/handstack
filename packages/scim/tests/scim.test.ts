import { describe, expect, it } from 'vitest';
import { RateLimitError } from '@handstack/shared';
import {
  InMemoryScimAuditSink,
  InMemoryScimCredentialStore,
  InMemoryScimStore,
  ScimConflictError,
  ScimCredentialService,
  ScimNotFoundError,
  ScimProvisioningService,
  TokenBucketScimRateLimiter,
} from '../src/index.js';

const alice = {
  externalId: 'ext-alice',
  userName: 'alice',
  displayName: 'Alice Example',
  emails: [{ value: 'alice@example.com', primary: true }],
};
const bob = { externalId: 'ext-bob', userName: 'bob', displayName: 'Bob Example' };

describe('SCIM provisioning', () => {
  it('creates, updates, deactivates and reactivates a tenant-scoped user', async () => {
    const service = new ScimProvisioningService(new InMemoryScimStore());
    const created = await service.createUser('org', alice);
    expect(created.active).toBe(true);
    expect(created.meta.version).toBe(1);
    expect(created.meta.location).toBe(`/scim/v2/Users/${created.id}`);
    await expect(service.getUser('other', created.id)).resolves.toBeUndefined();

    const renamed = await service.updateUser('org', created.id, { displayName: 'Alice A.' }, 1);
    expect(renamed.displayName).toBe('Alice A.');
    expect(renamed.meta.version).toBe(2);

    const inactive = await service.deactivateUser('org', created.id, 2);
    expect(inactive.active).toBe(false);
    const active = await service.reactivateUser('org', created.id, 3);
    expect(active.active).toBe(true);

    // Idempotent upsert by externalId returns the same record without modification.
    const existing = await service.upsertUser('org', alice);
    expect(existing.id).toBe(created.id);
  });

  it('enforces externalId and userName uniqueness per organization', async () => {
    const service = new ScimProvisioningService(new InMemoryScimStore());
    await service.createUser('org', alice);
    await expect(service.createUser('org', { ...bob, userName: 'alice' })).rejects.toThrow(
      /userName already exists/,
    );
    await expect(service.createUser('org', { ...bob, externalId: 'ext-alice' })).rejects.toThrow(
      /externalId already exists/,
    );
    // The same externalId is allowed in another organization.
    await expect(service.createUser('other', alice)).resolves.toMatchObject({ active: true });
  });

  it('rejects version conflicts and cross-tenant mutations', async () => {
    const service = new ScimProvisioningService(new InMemoryScimStore());
    const created = await service.createUser('org', alice);
    await expect(service.updateUser('org', created.id, { displayName: 'x' }, 99)).rejects.toThrow(
      /version conflict/,
    );
    await expect(service.updateUser('other', created.id, { displayName: 'x' }, 1)).rejects.toThrow(
      /not found/,
    );
  });

  it('manages groups and memberships with tenant isolation', async () => {
    const service = new ScimProvisioningService(new InMemoryScimStore());
    const first = await service.createUser('org', alice);
    const second = await service.createUser('org', bob);
    const group = await service.createGroup('org', {
      displayName: 'developers',
      members: [{ value: first.id }],
    });
    expect(group.members).toHaveLength(1);

    await expect(service.createGroup('org', { displayName: 'developers' })).rejects.toThrow(
      /displayName already exists/,
    );
    await expect(
      service.createGroup('org', { displayName: 'empty', members: [{ value: 'missing' }] }),
    ).rejects.toThrow(/member user not found/);

    const withSecond = await service.addGroupMember('org', group.id, second.id, 1);
    expect(withSecond.members).toHaveLength(2);
    const removed = await service.removeGroupMember('org', group.id, first.id, 2);
    expect(removed.members?.map((member) => member.value)).toEqual([second.id]);

    await expect(service.getGroup('other', group.id)).resolves.toBeUndefined();
    await expect(service.addGroupMember('other', group.id, first.id, 3)).rejects.toThrow(
      /not found/,
    );
  });

  it('paginates users and groups with SCIM list semantics', async () => {
    const service = new ScimProvisioningService(new InMemoryScimStore());
    await service.createUser('org', { userName: 'u1', displayName: 'U1' });
    await service.createUser('org', { userName: 'u2', displayName: 'U2' });
    await service.createUser('org', { userName: 'u3', displayName: 'U3' });
    const page = await service.listUsers('org', 2, 1);
    expect(page.totalResults).toBe(3);
    expect(page.startIndex).toBe(2);
    expect(page.itemsPerPage).toBe(1);
    expect(page.Resources).toHaveLength(1);
    expect(page.Resources[0]?.userName).toBe('u2');
  });

  it('applies rate limits and records redacted audit events', async () => {
    const limiter = new TokenBucketScimRateLimiter(1, 0.001, () => 0);
    const audit = new InMemoryScimAuditSink();
    const service = new ScimProvisioningService(new InMemoryScimStore(), limiter, audit);
    const created = await service.createUser('org', alice);
    await expect(service.createUser('org', bob)).rejects.toBeInstanceOf(RateLimitError);
    expect(audit.events[0]).toMatchObject({
      action: 'USER_CREATED',
      resourceType: 'User',
      resourceId: created.id,
      externalId: 'ext-alice',
    });
  });

  it('uses typed not-found and conflict errors for HTTP mapping', async () => {
    const service = new ScimProvisioningService(new InMemoryScimStore());
    const created = await service.createUser('org', alice);
    await expect(service.getUser('other', created.id)).resolves.toBeUndefined();
    await expect(
      service.updateUser('other', created.id, { displayName: 'x' }, 1),
    ).rejects.toBeInstanceOf(ScimNotFoundError);
    await expect(
      service.updateUser('org', created.id, { displayName: 'x' }, 99),
    ).rejects.toBeInstanceOf(ScimConflictError);
    await expect(service.createUser('org', { ...bob, userName: 'alice' })).rejects.toBeInstanceOf(
      ScimConflictError,
    );
  });
});

describe('SCIM dedicated bearer credentials', () => {
  const pepper = 'scim-test-pepper-at-least-16-chars';

  it('issues, authenticates, rotates and revokes a tenant token', async () => {
    const service = new ScimCredentialService(new InMemoryScimCredentialStore(), pepper);
    const issued = await service.issue('org-a');
    expect(issued.token.startsWith('hs_scim_')).toBe(true);
    await expect(service.authenticate(issued.token)).resolves.toBe('org-a');

    const rotated = await service.issue('org-a');
    await expect(service.authenticate(rotated.token)).resolves.toBe('org-a');
    await expect(service.authenticate(issued.token)).resolves.toBeUndefined();

    await service.revoke('org-a');
    await expect(service.authenticate(rotated.token)).resolves.toBeUndefined();
    await expect(service.hasCredential('org-a')).resolves.toBe(false);
  });

  it('keeps credentials isolated and rejects malformed or foreign tokens', async () => {
    const service = new ScimCredentialService(new InMemoryScimCredentialStore(), pepper);
    const token = (await service.issue('org-a')).token;
    await expect(service.authenticate(token)).resolves.toBe('org-a');
    await expect(service.authenticate('hs_scim_wrong')).resolves.toBeUndefined();
    await expect(service.authenticate('')).resolves.toBeUndefined();
    // A token for another organization cannot authenticate org-a's credential.
    const other = await service.issue('org-b');
    await expect(service.authenticate(other.token)).resolves.toBe('org-b');
    await expect(service.authenticate(token)).resolves.toBe('org-a');
  });
});
