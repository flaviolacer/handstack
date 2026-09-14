import { describe, expect, it } from 'vitest';
import { NotificationRuntimeService } from '../src/notifications/notification-runtime.service.js';

describe('NotificationRuntimeService', () => {
  it('dispatches and lists tenant-scoped in-app notifications', async () => {
    const runtime = new NotificationRuntimeService();
    await runtime.send({
      id: 'n1',
      organizationId: 'org-a',
      recipientId: 'user-a',
      channel: 'IN_APP',
      subject: 'Ready',
      body: 'Your agent is ready',
      createdAt: new Date(),
    });
    await expect(runtime.list('org-a', 'user-a')).resolves.toHaveLength(1);
    await expect(runtime.list('org-b', 'user-a')).resolves.toHaveLength(0);
  });
});
