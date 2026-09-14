import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { describe, expect, it } from 'vitest';
import { VirtualApiKeyService } from '../src/index.js';

const pepper = 'gateway-test-pepper-at-least-thirty-two-characters';

describe('virtual API keys', () => {
  it('rejects invalid expiration and denies a key exactly at its expiry', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      let timestamp = new Date('2026-09-09T12:00:00Z');
      const service = new VirtualApiKeyService(adapter, pepper, undefined, () => timestamp);
      const input = {
        organizationId: 'org',
        ownerId: 'user-1',
        ownerType: 'USER' as const,
        name: 'Expiring',
        environment: 'test' as const,
        permissions: ['models.execute'],
      };
      for (const expiresAt of [new Date(NaN), timestamp, new Date(timestamp.getTime() - 1)]) {
        await expect(service.issue({ ...input, expiresAt })).rejects.toThrow(/Expiration/);
      }
      const expiresAt = new Date(timestamp.getTime() + 60_000);
      const issued = await service.issue({ ...input, expiresAt });
      await expect(service.authenticate(issued.secret)).resolves.toBeDefined();
      timestamp = expiresAt;
      await expect(service.authenticate(issued.secret)).rejects.toThrow(/Invalid/);
    } finally {
      await adapter.close();
    }
  });

  it('returns the hs_live secret once and persists only its HMAC', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const service = new VirtualApiKeyService(
        adapter,
        pepper,
        undefined,
        undefined,
        () => 'secret-material',
      );
      const issued = await service.issue({
        organizationId: 'org/a',
        ownerId: 'application-1',
        ownerType: 'APPLICATION',
        name: 'Production gateway',
        environment: 'live',
        permissions: ['models.execute'],
        models: ['smart'],
      });
      expect(issued.secret).toMatch(/^hs_live_/);
      expect(JSON.stringify(issued.key)).not.toContain('secret-material');
      const authenticated = await service.authenticate(issued.secret, 'smart');
      expect(authenticated).toMatchObject({
        organizationId: 'org/a',
        ownerId: 'application-1',
      });
      expect(authenticated.lastUsedAt).toBeInstanceOf(Date);
      await expect(service.authenticate(issued.secret, 'other')).rejects.toThrow(/Invalid/);
    } finally {
      await adapter.close();
    }
  });

  it('enforces expiry, revocation and a replaceable per-key rate limit', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const service = new VirtualApiKeyService(
        adapter,
        pepper,
        undefined,
        undefined,
        () => 'rate-secret',
      );
      const issued = await service.issue({
        organizationId: 'org',
        ownerId: 'service-1',
        ownerType: 'SERVICE_ACCOUNT',
        name: 'Limited',
        environment: 'test',
        permissions: ['models.execute'],
        requestsPerMinute: 1,
      });
      expect(issued.secret).toMatch(/^hs_test_/);
      await expect(service.authenticate(issued.secret)).resolves.toBeDefined();
      await expect(service.authenticate(issued.secret)).rejects.toThrow(/rate limit/);
      await service.revoke('org', issued.key.id);
      await expect(service.authenticate(issued.secret)).rejects.toThrow(/Invalid/);
    } finally {
      await adapter.close();
    }
  });

  it('enforces and settles a per-key USD budget atomically', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const service = new VirtualApiKeyService(
        adapter,
        pepper,
        undefined,
        undefined,
        () => 'budget-secret',
      );
      const issued = await service.issue({
        organizationId: 'org',
        ownerId: 'billing-user',
        ownerType: 'USER',
        name: 'Budgeted',
        environment: 'test',
        permissions: ['models.execute'],
        budgetUsd: 1,
      });
      const reserved = await service.reserveBudget('org', issued.key.id, 0.75);
      expect(reserved.reservedUsd).toBeCloseTo(0.75);
      await expect(service.reserveBudget('org', issued.key.id, 0.3)).rejects.toThrow(/budget/i);
      const settled = await service.settleBudget('org', issued.key.id, 0.75, 0.4);
      expect(settled.reservedUsd).toBe(0);
      expect(settled.spentUsd).toBeCloseTo(0.4);
      await expect(service.reserveBudget('org', issued.key.id, 0.7)).rejects.toThrow(/budget/i);
    } finally {
      await adapter.close();
    }
  });
});
