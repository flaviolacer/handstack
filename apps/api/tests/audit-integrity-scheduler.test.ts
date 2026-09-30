import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { repositoryName } from '@handstack/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditIntegritySchedulerService } from '../src/audit/audit-integrity-scheduler.service.js';

describe('audit integrity scheduler', () => {
  afterEach(() => {
    delete process.env.HANDSTACK_AUDIT_INTEGRITY_ENABLED;
    delete process.env.HANDSTACK_AUDIT_INTEGRITY_INTERVAL_MS;
    delete process.env.HANDSTACK_AUDIT_INTEGRITY_ORGANIZATIONS;
    delete process.env.HANDSTACK_AUDIT_INTEGRITY_INSTANCE_ID;
  });

  it('verifies and records each tenant under a durable lease', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const verified: string[] = [];
      const recorded: string[] = [];
      const scheduler = new AuditIntegritySchedulerService(
        {
          audit: {
            verify: (organizationId: string) => {
              verified.push(organizationId);
              return Promise.resolve({ valid: true, checked: 4, errors: [] });
            },
            record: (input: { organizationId: string; action: string }) => {
              recorded.push(`${input.organizationId}:${input.action}`);
              return Promise.resolve();
            },
          },
        } as never,
        { adapter } as never,
      );
      process.env.HANDSTACK_AUDIT_INTEGRITY_INSTANCE_ID = 'audit-scheduler-a';
      await scheduler.tick(['org-audit']);
      expect(verified).toEqual(['org-audit']);
      expect(recorded).toEqual(['org-audit:AUDIT_VERIFIED']);
      const lease = await adapter
        .repository<{
          id: string;
          tenantId: string;
          organizationId: string;
          version: number;
          createdAt: Date;
          updatedAt: Date;
          leaseUntil: number;
        }>(repositoryName('audit-integrity-scheduler-leases'))
        .findById('org-audit', 'org-audit:audit-integrity');
      expect(lease).toMatchObject({ organizationId: 'org-audit', leaseUntil: 0 });
    } finally {
      await adapter.close();
    }
  });

  it('fails closed and releases the lease when the chain is invalid', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      let recorded = false;
      const scheduler = new AuditIntegritySchedulerService(
        {
          audit: {
            verify: () => Promise.resolve({ valid: false, checked: 2, errors: ['hash mismatch'] }),
            record: () => {
              recorded = true;
              return Promise.resolve();
            },
          },
        } as never,
        { adapter } as never,
      );
      await expect(scheduler.tick(['org-invalid'])).rejects.toThrow(
        'Audit integrity verification failed for at least one organization',
      );
      expect(recorded).toBe(false);
      const lease = await adapter
        .repository<{
          id: string;
          tenantId: string;
          organizationId: string;
          version: number;
          createdAt: Date;
          updatedAt: Date;
          leaseUntil: number;
        }>(repositoryName('audit-integrity-scheduler-leases'))
        .findById('org-invalid', 'org-invalid:audit-integrity');
      expect(lease).toMatchObject({ leaseUntil: 0 });
    } finally {
      await adapter.close();
    }
  });
});
