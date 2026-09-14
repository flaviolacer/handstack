import { describe, expect, it } from 'vitest';
import {
  InMemoryDataLifecycleProvider,
  InMemoryDataResidencyProvider,
  InMemoryDataSubjectRequestProvider,
} from '../src/index.js';

describe('privacy and lifecycle contracts', () => {
  it('plans deletion but legal hold blocks execution until released', async () => {
    const provider = new InMemoryDataLifecycleProvider();
    const createdAt = new Date(Date.now() - 86_400_000);
    const resource = {
      organizationId: 'org',
      resourceType: 'conversation',
      resourceId: 'c1',
      createdAt,
    };
    const plan = await provider.plan(resource, {
      organizationId: 'org',
      resourceType: 'conversation',
      retentionDays: 0,
    });
    provider.addLegalHold({
      id: 'hold',
      organizationId: 'org',
      resourceId: 'c1',
      reason: 'litigation',
      active: true,
    });
    await expect(provider.execute(plan)).resolves.toMatchObject({ deleted: false });
    provider.removeLegalHold('hold');
    await expect(provider.execute(plan)).resolves.toMatchObject({ deleted: true });
  });

  it('requires approved subject requests and allowed residency', async () => {
    const requests = new InMemoryDataSubjectRequestProvider();
    await expect(
      requests.execute({
        id: 'r',
        organizationId: 'org',
        subjectId: 'u',
        type: 'EXPORT',
        status: 'RECEIVED',
      }),
    ).rejects.toThrow(/approved/);
    await expect(
      requests.execute({
        id: 'r',
        organizationId: 'org',
        subjectId: 'u',
        type: 'EXPORT',
        status: 'APPROVED',
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED' });
    const residency = new InMemoryDataResidencyProvider();
    residency.setAllowedRegions('org', ['br-south']);
    await expect(
      residency.authorizePlacement({
        organizationId: 'org',
        region: 'us-east',
        classification: 'RESTRICTED',
      }),
    ).resolves.toMatchObject({ allowed: false });
  });
});
