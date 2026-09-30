import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { repositoryName } from '@handstack/domain';
import type { Organization } from '@handstack/identity';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivacyRetentionSchedulerService } from '../src/privacy/privacy-retention-scheduler.service.js';

describe('privacy retention scheduler', () => {
  afterEach(() => {
    delete process.env.HANDSTACK_PRIVACY_RETENTION_ENABLED;
    delete process.env.HANDSTACK_PRIVACY_RETENTION_INTERVAL_MS;
    delete process.env.HANDSTACK_PRIVACY_RETENTION_ORGANIZATIONS;
    delete process.env.HANDSTACK_PRIVACY_RETENTION_INSTANCE_ID;
  });

  it('arbitrates a tenant across instances with a durable lease', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const calls: string[] = [];
      const actors: string[] = [];
      let finishFirst!: () => void;
      let startFirst!: () => void;
      const started = new Promise<void>((resolve) => {
        startFirst = resolve;
      });
      const finish = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const privacy = {
        runConversationRetention: async (organizationId: string, actorId: string) => {
          calls.push(organizationId);
          actors.push(actorId);
          if (calls.length === 1) {
            startFirst();
            await finish;
          }
          return { deleted: 0, retained: 0 };
        },
        runUsageRetention: () => Promise.resolve({ deleted: 0, retained: 0 }),
        runAttachmentRetention: () => Promise.resolve({ deleted: 0, retained: 0 }),
        runTraceRetention: () => Promise.resolve({ deleted: 0, retained: 0 }),
      };
      const database = { adapter };
      process.env.HANDSTACK_PRIVACY_RETENTION_INSTANCE_ID = 'privacy-scheduler-a';
      const first = new PrivacyRetentionSchedulerService(privacy as never, database as never);
      const firstTick = first.tick(['org-retention']);
      await started;

      process.env.HANDSTACK_PRIVACY_RETENTION_INSTANCE_ID = 'privacy-scheduler-b';
      const second = new PrivacyRetentionSchedulerService(privacy as never, database as never);
      await second.tick(['org-retention']);
      expect(calls).toEqual(['org-retention']);
      expect(actors).toEqual(['system:privacy-retention-scheduler']);

      finishFirst();
      await firstTick;
      await second.tick(['org-retention']);
      expect(calls).toEqual(['org-retention', 'org-retention']);
      expect(actors).toEqual([
        'system:privacy-retention-scheduler',
        'system:privacy-retention-scheduler',
      ]);
      const lease = await adapter
        .repository<{
          id: string;
          tenantId: string;
          organizationId: string;
          version: number;
          createdAt: Date;
          updatedAt: Date;
          ownerId: string;
          leaseUntil: number;
        }>(repositoryName('privacy-retention-scheduler-leases'))
        .findById('org-retention', 'org-retention:privacy-retention');
      expect(lease).toMatchObject({ ownerId: 'privacy-scheduler-b', leaseUntil: 0 });
    } finally {
      await adapter.close();
    }
  });

  it('discovers only active organizations when a tick has no explicit tenant list', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const organizations = adapter.repository<{
        id: string;
        tenantId: string;
        version: number;
        createdAt: Date;
        updatedAt: Date;
        status: string;
      }>(repositoryName('identity-organizations'));
      const rows: readonly (readonly [string, string])[] = [
        ['org-active-retention', 'ACTIVE'],
        ['org-disabled-retention', 'DISABLED'],
      ];
      for (const [id, status] of rows) {
        await organizations.insert({
          id,
          tenantId: id,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          status,
        });
      }
      const calls: string[] = [];
      const scheduler = new PrivacyRetentionSchedulerService(
        {
          runConversationRetention: (organizationId: string) => {
            calls.push(organizationId);
            return Promise.resolve({ deleted: 0, retained: 0 });
          },
          runUsageRetention: () => Promise.resolve({ deleted: 0, retained: 0 }),
          runAttachmentRetention: () => Promise.resolve({ deleted: 0, retained: 0 }),
          runTraceRetention: () => Promise.resolve({ deleted: 0, retained: 0 }),
        } as never,
        { adapter } as never,
      );
      await scheduler.tick();
      expect(calls).toEqual(['org-active-retention']);
    } finally {
      await adapter.close();
    }
  });

  it('starts the scheduled tenant sweep only when explicitly enabled', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    const calls: string[] = [];
    const scheduler = new PrivacyRetentionSchedulerService(
      {
        runConversationRetention: (organizationId: string) => {
          calls.push(organizationId);
          return Promise.resolve({ deleted: 0, retained: 0 });
        },
        runUsageRetention: () => Promise.resolve({ deleted: 0, retained: 0 }),
        runAttachmentRetention: () => Promise.resolve({ deleted: 0, retained: 0 }),
        runTraceRetention: () => Promise.resolve({ deleted: 0, retained: 0 }),
      } as never,
      { adapter } as never,
    );
    try {
      await adapter.repository<Organization>(repositoryName('identity-organizations')).insert({
        id: 'org-scheduled-retention',
        tenantId: 'org-scheduled-retention',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'ACTIVE',
        name: 'Scheduled retention org',
        slug: 'scheduled-retention-org',
      });
      process.env.HANDSTACK_PRIVACY_RETENTION_ENABLED = 'true';
      process.env.HANDSTACK_PRIVACY_RETENTION_INTERVAL_MS = '60000';
      await scheduler.onModuleInit();
      await vi.waitFor(() => {
        expect(calls).toEqual(['org-scheduled-retention']);
      });
    } finally {
      scheduler.onModuleDestroy();
      await adapter.close();
    }
  });

  it('runs conversation, usage and attachment retention under one tenant lease', async () => {
    const calls: string[] = [];
    const scheduler = new PrivacyRetentionSchedulerService({
      runConversationRetention: () => {
        calls.push('conversation');
        return Promise.resolve({ deleted: 0, retained: 0 });
      },
      runUsageRetention: () => {
        calls.push('usage');
        return Promise.resolve({ deleted: 0, retained: 0 });
      },
      runAttachmentRetention: () => {
        calls.push('attachments');
        return Promise.resolve({ deleted: 0, retained: 0 });
      },
      runTraceRetention: () => {
        calls.push('traces');
        return Promise.resolve({ deleted: 0, retained: 0 });
      },
    } as never);

    await scheduler.tick(['org-retention-sweep']);

    expect(calls).toEqual(['conversation', 'usage', 'attachments', 'traces']);
  });

  it('prunes webhook deliveries under the same tenant lease', async () => {
    const calls: string[] = [];
    const scheduler = new PrivacyRetentionSchedulerService(
      {
        runConversationRetention: () => {
          calls.push('conversation');
          return Promise.resolve({ deleted: 0, retained: 0 });
        },
        runUsageRetention: () => {
          calls.push('usage');
          return Promise.resolve({ deleted: 0, retained: 0 });
        },
        runAttachmentRetention: () => {
          calls.push('attachments');
          return Promise.resolve({ deleted: 0, retained: 0 });
        },
        runTraceRetention: () => {
          calls.push('traces');
          return Promise.resolve({ deleted: 0, retained: 0 });
        },
      } as never,
      undefined,
      {
        prune: (organizationId: string) => {
          calls.push(`webhooks:${organizationId}`);
          return Promise.resolve(2);
        },
      } as never,
    );

    await scheduler.tick(['org-retention-sweep']);

    expect(calls).toEqual([
      'conversation',
      'usage',
      'attachments',
      'traces',
      'webhooks:org-retention-sweep',
    ]);
  });
});
