import { describe, expect, it } from 'vitest';
import {
  InMemoryDataLifecycleProvider,
  InMemoryDataResidencyProvider,
  InMemoryDataSubjectRequestProvider,
  DataDeletionPropagator,
  InMemorySubjectCache,
  InMemoryBackupTombstoneLedger,
  ExternalBackupTombstoneAdapter,
  RedisSubjectCache,
} from '../src/index.js';

describe('privacy and lifecycle contracts', () => {
  it('propagates subject deletion to registered destinations and fails closed when absent', async () => {
    const propagator = new DataDeletionPropagator();
    propagator.register({
      destination: 'CACHE',
      deleteSubject: ({ organizationId, subjectId }) =>
        Promise.resolve({
          destination: 'CACHE',
          deleted: true,
          evidence: [`cache:${organizationId}:${subjectId}`],
        }),
    });
    await expect(
      propagator.propagate({ organizationId: 'org', subjectId: 'user', requestId: 'request' }, [
        'CACHE',
        'QUEUE',
      ]),
    ).resolves.toEqual([
      { destination: 'CACHE', deleted: true, evidence: ['cache:org:user'] },
      { destination: 'QUEUE', deleted: false, evidence: ['adapter-missing:QUEUE'] },
    ]);
    expect(() => {
      propagator.register({
        destination: 'CACHE',
        deleteSubject: () => Promise.resolve({ destination: 'CACHE', deleted: true, evidence: [] }),
      });
    }).toThrow(/already registered/);
  });
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
  it('records external adapter failures as retryable partial deletion evidence', async () => {
    const propagator = new DataDeletionPropagator();
    propagator.register({
      destination: 'OBJECT_STORAGE',
      deleteSubject: () => Promise.reject(new Error('provider secret must not escape')),
    });
    await expect(
      propagator.propagate({ organizationId: 'org', subjectId: 'user', requestId: 'request' }, [
        'OBJECT_STORAGE',
      ]),
    ).resolves.toEqual([
      {
        destination: 'OBJECT_STORAGE',
        deleted: false,
        evidence: ['adapter-error:OBJECT_STORAGE'],
      },
    ]);
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

  it('purges tenant cache entries and records backup tombstones', async () => {
    const input = { organizationId: 'org-a', subjectId: 'user-a', requestId: 'request-a' };
    const cache = new InMemorySubjectCache();
    cache.set('owned', 'org-a', 'secret', 'user-a');
    cache.set('other', 'org-a', 'keep', 'user-b');
    await expect(cache.deleteSubject(input)).resolves.toMatchObject({
      deleted: true,
      evidence: ['cache-entries-removed:1'],
    });
    expect(cache.get('owned', 'org-a')).toBeUndefined();
    expect(cache.get('other', 'org-a')).toBe('keep');
    const backups = new InMemoryBackupTombstoneLedger();
    await expect(backups.deleteSubject(input)).resolves.toMatchObject({
      destination: 'BACKUP',
      deleted: true,
    });
    expect(backups.hasTombstone('org-a', 'user-a')).toBe(true);
  });
  it('purges subject-indexed entries from the Redis cache without crossing tenants', async () => {
    const values = new Map<string, string>();
    const index = new Map<string, Set<string>>();
    const redis = {
      set: (key: string, value: string) => {
        values.set(key, value);
        return Promise.resolve('OK');
      },
      get: (key: string) => Promise.resolve(values.get(key) ?? null),
      sadd: (key: string, member: string) => {
        const members = index.get(key) ?? new Set<string>();
        const before = members.size;
        members.add(member);
        index.set(key, members);
        return Promise.resolve(members.size === before ? 0 : 1);
      },
      srem: (key: string, member: string) => {
        const members = index.get(key);
        if (members?.delete(member) !== true) return Promise.resolve(0);
        if (members.size === 0) index.delete(key);
        return Promise.resolve(1);
      },
      smembers: (key: string) => Promise.resolve([...(index.get(key) ?? new Set<string>())]),
      del: (...keys: readonly string[]) => {
        let deleted = 0;
        for (const key of keys) {
          if (values.delete(key)) deleted += 1;
          if (index.delete(key)) deleted += 1;
        }
        return Promise.resolve(deleted);
      },
    };
    const cache = new RedisSubjectCache(redis);
    await cache.set('owned', 'org-a', 'secret', 'user-a');
    await cache.set('other', 'org-a', 'keep', 'user-b');
    await cache.set('same-subject', 'org-b', 'isolation', 'user-a');
    await expect(cache.get('owned', 'org-a')).resolves.toBe('secret');
    await expect(
      cache.deleteSubject({ organizationId: 'org-a', subjectId: 'user-a', requestId: 'r' }),
    ).resolves.toEqual({
      destination: 'CACHE',
      deleted: true,
      evidence: ['redis-cache-entries-removed:1'],
    });
    await expect(cache.get('owned', 'org-a')).resolves.toBeNull();
    await expect(cache.get('other', 'org-a')).resolves.toBe('keep');
    await expect(cache.get('same-subject', 'org-b')).resolves.toBe('isolation');
  });
  it('moves a reused Redis cache key between subject indexes safely', async () => {
    const values = new Map<string, string>();
    const index = new Map<string, Set<string>>();
    const redis = {
      set: (key: string, value: string) => {
        values.set(key, value);
        return Promise.resolve('OK');
      },
      get: (key: string) => Promise.resolve(values.get(key) ?? null),
      sadd: (key: string, member: string) => {
        const members = index.get(key) ?? new Set<string>();
        const before = members.size;
        members.add(member);
        index.set(key, members);
        return Promise.resolve(members.size === before ? 0 : 1);
      },
      srem: (key: string, member: string) => {
        const members = index.get(key);
        if (members?.delete(member) !== true) return Promise.resolve(0);
        if (members.size === 0) index.delete(key);
        return Promise.resolve(1);
      },
      smembers: (key: string) => Promise.resolve([...(index.get(key) ?? new Set<string>())]),
      del: (...keys: readonly string[]) => {
        let deleted = 0;
        for (const key of keys) {
          if (values.delete(key)) deleted += 1;
          if (index.delete(key)) deleted += 1;
        }
        return Promise.resolve(deleted);
      },
    };
    const cache = new RedisSubjectCache(redis);
    await cache.set('reused', 'org-a', 'first', 'user-a');
    await cache.set('reused', 'org-a', 'second', 'user-b');
    await expect(
      cache.deleteSubject({ organizationId: 'org-a', subjectId: 'user-a', requestId: 'r-a' }),
    ).resolves.toMatchObject({ evidence: ['redis-cache-entries-removed:0'] });
    await expect(cache.get('reused', 'org-a')).resolves.toBe('second');
    await expect(
      cache.deleteSubject({ organizationId: 'org-a', subjectId: 'user-b', requestId: 'r-b' }),
    ).resolves.toMatchObject({ evidence: ['redis-cache-entries-removed:1'] });
    await expect(cache.get('reused', 'org-a')).resolves.toBeNull();
  });
  it('writes tenant-scoped deletion tombstones to an external backup store', async () => {
    const objects = new Map<string, string>();
    const adapter = new ExternalBackupTombstoneAdapter({
      put: (key, value) => {
        objects.set(key, value);
        return Promise.resolve();
      },
    });
    await expect(
      adapter.deleteSubject({ organizationId: 'org-a', subjectId: 'user-a', requestId: 'req-a' }),
    ).resolves.toEqual({
      destination: 'BACKUP',
      deleted: true,
      evidence: ['external-backup-tombstone:org-a:user-a'],
    });
    expect(objects.size).toBe(1);
    const [key, value] = [...objects.entries()][0] ?? [];
    expect(key).toContain('org-a/user-a');
    expect(JSON.parse(value ?? '{}')).toMatchObject({
      organizationId: 'org-a',
      subjectId: 'user-a',
      requestId: 'req-a',
    });
    expect(JSON.stringify(value)).not.toContain('secret');
  });
});
