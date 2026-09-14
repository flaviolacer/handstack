import { describe, expect, it } from 'vitest';
import {
  DurableAccessService,
  InMemoryAccessService,
  InMemoryAccessStore,
  InMemoryNotificationProvider,
} from '../src/index.js';

describe('temporary access and notifications', () => {
  it('approves tenant-scoped grants with expiry and emits notifications', () => {
    const notifications = new InMemoryNotificationProvider();
    const access = new InMemoryAccessService(notifications);
    const request = access.submit({
      organizationId: 'org-1',
      requesterId: 'user-1',
      resource: 'repo:private',
      reason: 'incident',
      duration: '1h',
      reference: 'INC-1',
    });
    const grant = access.approve('org-1', request.id, 'admin');
    expect(access.active('org-1', 'user-1', 'repo:private')).toHaveLength(1);
    expect(access.active('org-2', 'user-1', 'repo:private')).toHaveLength(0);
    expect(grant.expiresAt).toBeInstanceOf(Date);
    expect(notifications.notifications.map((item) => item.type)).toEqual([
      'access.requested',
      'access.approved',
    ]);
  });
  it('rejects cross-tenant access and supports revocation', () => {
    const access = new InMemoryAccessService();
    const request = access.submit({
      organizationId: 'org-1',
      requesterId: 'user',
      resource: 'db',
      reason: 'debug',
      duration: 'permanent',
    });
    expect(() => access.approve('org-2', request.id, 'admin')).toThrow('not found');
    const grant = access.approve('org-1', request.id, 'admin');
    access.revoke('org-1', grant.id);
    expect(access.active('org-1', 'user', 'db')).toHaveLength(0);
  });
  it('persists durable requests and grants through an async store', async () => {
    const notifications = new InMemoryNotificationProvider();
    const access = new DurableAccessService(
      new InMemoryAccessStore(),
      notifications,
      () => new Date('2026-01-01T00:00:00Z'),
    );
    const request = await access.submit({
      organizationId: 'org-1',
      requesterId: 'user',
      resource: 'db',
      reason: 'debug',
      duration: '1h',
    });
    const grant = await access.approve('org-1', request.id, 'admin');
    await expect(access.active('org-1', 'user', 'db')).resolves.toHaveLength(1);
    expect(grant.expiresAt?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    expect(notifications.notifications).toHaveLength(2);
  });
});
