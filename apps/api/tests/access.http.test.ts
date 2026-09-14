import { describe, expect, it } from 'vitest';
import { AccessRuntimeService } from '../src/access/access-runtime.service.js';

describe('AccessRuntimeService', () => {
  it('exposes the tenant-scoped access and notification services', async () => {
    const runtime = new AccessRuntimeService();
    const request = await runtime.access.submit({
      organizationId: 'org',
      requesterId: 'user',
      resource: 'db',
      reason: 'incident',
      duration: '1h',
    });
    expect(await Promise.resolve(runtime.access.list('org'))).toHaveLength(1);
    expect(runtime.notifications.notifications[0]?.type).toBe('access.requested');
    expect(request.organizationId).toBe('org');
  });
});
