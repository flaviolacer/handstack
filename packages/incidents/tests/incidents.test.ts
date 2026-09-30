import { describe, expect, it } from 'vitest';
import {
  DefaultIncidentManagementProvider,
  InMemoryIncidentStore,
  InMemoryStatusPageProvider,
  InMemoryIncidentNotificationDispatcher,
  RepositoryIncidentEscalationPolicyStore,
} from '../src/index.js';

const input = {
  id: 'inc-1',
  organizationId: 'org',
  severity: 'SEV2' as const,
  status: 'DETECTED' as const,
  startedAt: new Date(),
  detectedAt: new Date(),
  affectedOrganizations: ['org'],
  affectedCapabilities: ['gateway'],
  owner: 'on-call',
  customerImpact: 'Requests may fail',
  correctiveActions: [],
};
describe('incident management', () => {
  it('enforces lifecycle transitions and publishes customer-safe status', async () => {
    const page = new InMemoryStatusPageProvider();
    const provider = new DefaultIncidentManagementProvider(new InMemoryIncidentStore(), page);
    await provider.create(input);
    await expect(
      provider.transition({ organizationId: 'org', id: 'inc-1', status: 'RESOLVED', actor: 'u' }),
    ).rejects.toThrow(/transition/);
    await provider.transition({
      organizationId: 'org',
      id: 'inc-1',
      status: 'INVESTIGATING',
      actor: 'u',
      message: 'Investigating',
    });
    await provider.transition({
      organizationId: 'org',
      id: 'inc-1',
      status: 'IDENTIFIED',
      actor: 'u',
    });
    await provider.transition({
      organizationId: 'org',
      id: 'inc-1',
      status: 'MITIGATING',
      actor: 'u',
    });
    await provider.transition({
      organizationId: 'org',
      id: 'inc-1',
      status: 'MONITORING',
      actor: 'u',
    });
    const resolved = await provider.transition({
      organizationId: 'org',
      id: 'inc-1',
      status: 'RESOLVED',
      actor: 'u',
    });
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    expect(page.published[0]?.rootCause).toBeUndefined();
  });
  it('isolates tenants and is idempotent for the same status', async () => {
    const provider = new DefaultIncidentManagementProvider(new InMemoryIncidentStore());
    await provider.create(input);
    await expect(provider.get('other', 'inc-1')).resolves.toBeUndefined();
    await provider.transition({
      organizationId: 'org',
      id: 'inc-1',
      status: 'INVESTIGATING',
      actor: 'u',
    });
    await expect(
      provider.transition({
        organizationId: 'org',
        id: 'inc-1',
        status: 'INVESTIGATING',
        actor: 'u',
      }),
    ).resolves.toMatchObject({ status: 'INVESTIGATING' });
  });
  it('tracks corrective actions, escalation policy and lifecycle notifications', async () => {
    const notifications = new InMemoryIncidentNotificationDispatcher();
    const provider = new DefaultIncidentManagementProvider(
      new InMemoryIncidentStore(),
      undefined,
      notifications,
    );
    await provider.create({
      ...input,
      correctiveActions: [{ id: 'a1', description: 'Rotate key' }],
    });
    await provider.updateAction({
      organizationId: 'org',
      id: 'inc-1',
      actionId: 'a1',
      completed: true,
    });
    await expect(provider.getEscalationPolicy('org', 'gateway')).resolves.toBeUndefined();
    await provider.setEscalationPolicy({
      organizationId: 'org',
      capability: 'gateway',
      levels: [
        { afterMinutes: 0, owner: 'on-call' },
        { afterMinutes: 15, owner: 'lead' },
      ],
    });
    await expect(provider.getEscalationPolicy('org', 'gateway')).resolves.toMatchObject({
      levels: [{ owner: 'on-call' }, { owner: 'lead' }],
    });
    expect(notifications.sent.map((item) => item.event)).toEqual([
      'INCIDENT_CREATED',
      'INCIDENT_ACTION_UPDATED',
    ]);
  });

  it('persists escalation policies with tenant-scoped identity', async () => {
    interface PolicyEntity {
      readonly id: string;
      readonly tenantId: string;
      readonly version: number;
      readonly createdAt: Date;
      readonly updatedAt: Date;
      readonly capability: string;
      readonly levels: readonly { readonly afterMinutes: number; readonly owner: string }[];
    }
    const values = new Map<string, PolicyEntity>();
    const repository = {
      findById: (tenantId: string, id: string) => Promise.resolve(values.get(`${tenantId}:${id}`)),
      insert: (entity: PolicyEntity) => {
        values.set(`${entity.tenantId}:${entity.id}`, entity);
        return Promise.resolve(entity);
      },
      update: (entity: PolicyEntity) => {
        values.set(`${entity.tenantId}:${entity.id}`, entity);
        return Promise.resolve(entity);
      },
    };
    const policies = new RepositoryIncidentEscalationPolicyStore(() => repository as never);
    const provider = new DefaultIncidentManagementProvider(
      new InMemoryIncidentStore(),
      undefined,
      undefined,
      policies,
    );
    await provider.setEscalationPolicy({
      organizationId: 'org',
      capability: 'gateway',
      levels: [{ afterMinutes: 5, owner: 'on-call' }],
    });
    await expect(provider.getEscalationPolicy('org', 'gateway')).resolves.toMatchObject({
      organizationId: 'org',
      capability: 'gateway',
      levels: [{ afterMinutes: 5, owner: 'on-call' }],
    });
    await expect(provider.getEscalationPolicy('other', 'gateway')).resolves.toBeUndefined();
  });
});
