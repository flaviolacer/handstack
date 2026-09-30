import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { repositoryName, type TenantEntity } from '@handstack/domain';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeSyncSchedulerService } from '../src/knowledge/knowledge-sync-scheduler.service.js';

interface TestLease extends TenantEntity {
  readonly organizationId: string;
  readonly ownerId: string;
  readonly leaseUntil: number;
}

describe('knowledge sync scheduler', () => {
  it('synchronizes every concrete public and credential-backed source connector', async () => {
    const calls: string[] = [];
    const runtime = {
      listDocuments: (organizationId: string) =>
        Promise.resolve(
          [
            { id: 'url', sourceType: 'URL' },
            { id: 'github', sourceType: 'GITHUB' },
            { id: 'drive', sourceType: 'GOOGLE_DRIVE' },
            { id: 'sharepoint', sourceType: 'SHAREPOINT' },
            { id: 'confluence', sourceType: 'CONFLUENCE' },
            { id: 'notion', sourceType: 'NOTION' },
            { id: 's3', sourceType: 'S3' },
            { id: 'file', sourceType: 'FILE' },
            { id: 'text', sourceType: 'TEXT' },
            { id: 'database', sourceType: 'DATABASE' },
          ].map((document) => ({ ...document, organizationId })),
        ),
      syncUrl: (organizationId: string, documentId: string) => {
        calls.push(`${organizationId}/${documentId}`);
        return Promise.resolve();
      },
    };
    const previous = process.env.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS;
    process.env.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS = 'org-a';
    try {
      await expect(new KnowledgeSyncSchedulerService(runtime as never).tick()).resolves.toBe(7);
    } finally {
      if (previous === undefined) delete process.env.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS;
      else process.env.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS = previous;
    }
    expect(calls).toEqual([
      'org-a/url',
      'org-a/github',
      'org-a/drive',
      'org-a/sharepoint',
      'org-a/confluence',
      'org-a/notion',
      'org-a/s3',
    ]);
  });

  it('does not overlap ticks', async () => {
    let release: (() => void) | undefined;
    const runtime = {
      listDocuments: () =>
        new Promise<never[]>((resolve) => {
          release = () => {
            resolve([]);
          };
        }),
      syncUrl: () => Promise.resolve(),
    };
    const scheduler = new KnowledgeSyncSchedulerService(runtime as never);
    const first = scheduler.tick();
    await expect(scheduler.tick()).resolves.toBe(0);
    release?.();
    await expect(first).resolves.toBe(0);
  });

  it('discovers active organizations from the database when no allow-list is configured', async () => {
    const calls: string[] = [];
    const runtime = {
      listDocuments: (organizationId: string) =>
        Promise.resolve([{ id: 'url', sourceType: 'URL', organizationId }]),
      syncUrl: (organizationId: string, documentId: string) => {
        calls.push(`${organizationId}/${documentId}`);
        return Promise.resolve();
      },
    };
    const listAll = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          { id: 'org-a', status: 'ACTIVE' },
          { id: 'org-disabled', status: 'DISABLED' },
        ],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({ items: [{ id: 'org-b', status: 'ACTIVE' }] });
    const scheduler = new KnowledgeSyncSchedulerService(
      runtime as never,
      { adapter: { listAll } } as never,
    );

    await expect(scheduler.tick()).resolves.toBe(2);
    expect(calls).toEqual(['org-a/url', 'org-b/url']);
    expect(listAll).toHaveBeenCalledTimes(2);
  });

  it('arbitrates scheduler ownership across instances with a persisted tenant lease', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    const previousOrganizations = process.env.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS;
    const previousInstanceId = process.env.HANDSTACK_KNOWLEDGE_SYNC_INSTANCE_ID;
    process.env.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS = 'org-durable';
    const calls: string[] = [];
    let markStarted: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const firstSync = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let syncCount = 0;
    const runtime = {
      listDocuments: (organizationId: string) =>
        Promise.resolve([{ id: 's3-document', sourceType: 'S3', organizationId }]),
      syncUrl: (organizationId: string, documentId: string) => {
        calls.push(`${organizationId}/${documentId}`);
        syncCount += 1;
        if (syncCount === 1) {
          markStarted?.();
          return firstSync;
        }
        return Promise.resolve();
      },
    };

    try {
      process.env.HANDSTACK_KNOWLEDGE_SYNC_INSTANCE_ID = 'knowledge-sync-a';
      const first = new KnowledgeSyncSchedulerService(runtime as never, { adapter } as never);
      process.env.HANDSTACK_KNOWLEDGE_SYNC_INSTANCE_ID = 'knowledge-sync-b';
      const second = new KnowledgeSyncSchedulerService(runtime as never, { adapter } as never);

      const firstTick = first.tick();
      await started;
      await expect(second.tick()).resolves.toBe(0);
      expect(calls).toEqual(['org-durable/s3-document']);
      releaseFirst?.();
      await expect(firstTick).resolves.toBe(1);
      await expect(second.tick()).resolves.toBe(1);

      const lease = await adapter
        .repository<TestLease>(repositoryName('knowledge-sync-scheduler-leases'))
        .findById('org-durable', 'org-durable:knowledge-sync');
      expect(lease).toMatchObject({ ownerId: 'knowledge-sync-b', leaseUntil: 0 });
      expect(calls).toEqual(['org-durable/s3-document', 'org-durable/s3-document']);
    } finally {
      if (previousOrganizations === undefined)
        delete process.env.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS;
      else process.env.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS = previousOrganizations;
      if (previousInstanceId === undefined) delete process.env.HANDSTACK_KNOWLEDGE_SYNC_INSTANCE_ID;
      else process.env.HANDSTACK_KNOWLEDGE_SYNC_INSTANCE_ID = previousInstanceId;
      releaseFirst?.();
      await adapter.close();
    }
  });
});
