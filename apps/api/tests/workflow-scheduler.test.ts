import { afterEach, describe, expect, it } from 'vitest';
import { repositoryName, type TenantEntity } from '@handstack/domain';
import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { WorkflowSchedulerService } from '../src/workflows/workflow-scheduler.service.js';

interface TestLease extends TenantEntity {
  readonly organizationId: string;
  readonly ownerId: string;
  readonly leaseUntil: number;
}

describe('workflow scheduler distributed lease', () => {
  afterEach(() => {
    delete process.env.HANDSTACK_WORKFLOW_SCHEDULER_INSTANCE_ID;
    delete process.env.HANDSTACK_WORKFLOW_SCHEDULER_INTERVAL_MS;
  });

  it('excludes a live owner and allows takeover after lease expiry', async () => {
    process.env.HANDSTACK_WORKFLOW_SCHEDULER_INTERVAL_MS = '1000';
    let lease: TestLease | undefined;
    const repository = {
      findById: () => Promise.resolve(lease),
      insert: (value: TestLease) => {
        if (lease !== undefined) throw new Error('duplicate lease');
        lease = value;
        return Promise.resolve(value);
      },
      update: (value: TestLease, expectedVersion: number) => {
        if (lease?.version !== expectedVersion) throw new Error('stale lease');
        lease = value;
        return Promise.resolve(value);
      },
    };
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const workflows = {
      dispatchDueSchedules: async ({ organizationId }: { organizationId: string }) => {
        calls.push(organizationId);
        if (calls.length === 1) await firstStarted;
      },
    };
    const database = { adapter: { repository: () => repository } };

    process.env.HANDSTACK_WORKFLOW_SCHEDULER_INSTANCE_ID = 'scheduler-a';
    const first = new WorkflowSchedulerService(workflows as never, database as never);
    const firstTick = first.tick(['org-a']);
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.env.HANDSTACK_WORKFLOW_SCHEDULER_INSTANCE_ID = 'scheduler-b';
    const second = new WorkflowSchedulerService(workflows as never, database as never);
    await expect(second.tick(['org-a'])).resolves.toBeUndefined();
    expect(calls).toEqual(['org-a']);

    releaseFirst();
    await firstTick;
    if (lease === undefined) throw new Error('scheduler lease was not persisted');
    lease = { ...lease, leaseUntil: Date.now() - 1 };
    await second.tick(['org-a']);
    expect(calls).toEqual(['org-a', 'org-a']);
  });

  it('arbitrates scheduler ownership across two instances using a shared durable adapter', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const calls: string[] = [];
      const workflows = {
        dispatchDueSchedules: ({ organizationId }: { organizationId: string }) => {
          calls.push(organizationId);
          return Promise.resolve([]);
        },
      };
      const database = { adapter };
      process.env.HANDSTACK_WORKFLOW_SCHEDULER_INSTANCE_ID = 'durable-scheduler-a';
      const first = new WorkflowSchedulerService(workflows as never, database as never);
      process.env.HANDSTACK_WORKFLOW_SCHEDULER_INSTANCE_ID = 'durable-scheduler-b';
      const second = new WorkflowSchedulerService(workflows as never, database as never);

      await Promise.all([first.tick(['org-durable']), second.tick(['org-durable'])]);
      expect(calls).toHaveLength(1);
      expect(calls).toEqual(['org-durable']);

      await second.tick(['org-durable']);
      expect(calls).toEqual(['org-durable', 'org-durable']);
      const lease = await adapter
        .repository<TestLease>(repositoryName('workflow-scheduler-leases'))
        .findById('org-durable', 'org-durable:workflow-scheduler');
      expect(lease).toMatchObject({ ownerId: 'durable-scheduler-b', leaseUntil: 0 });
    } finally {
      await adapter.close();
    }
  });
});
