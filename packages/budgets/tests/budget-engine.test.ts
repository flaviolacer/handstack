import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { BudgetEngine, PricingCatalog } from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('BudgetEngine', () => {
  it('reserves atomically, is idempotent, settles usage and blocks hard limits', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const engine = new BudgetEngine(adapter, () => new Date('2026-09-09T12:00:00Z'));
      const budget = await engine.createBudget({
        organizationId: 'org',
        scope: { type: 'ORGANIZATION', key: 'org' },
        period: 'MONTHLY',
        strategy: 'HARD_LIMIT',
        limitUsd: 10,
      });
      const first = await engine.reserve({
        organizationId: 'org',
        principalId: 'user',
        idempotencyKey: 'request-1',
        estimateUsd: 6,
        scopes: [{ type: 'ORGANIZATION', key: 'org' }],
      });
      const repeated = await engine.reserve({
        organizationId: 'org',
        principalId: 'user',
        idempotencyKey: 'request-1',
        estimateUsd: 6,
        scopes: [{ type: 'ORGANIZATION', key: 'org' }],
      });
      expect(repeated.reservation.id).toBe(first.reservation.id);
      await expect(
        engine.reserve({
          organizationId: 'org',
          principalId: 'other',
          idempotencyKey: 'request-2',
          estimateUsd: 5,
          scopes: [{ type: 'ORGANIZATION', key: 'org' }],
        }),
      ).rejects.toThrow(/hard limit/);
      const settled = await engine.settle({
        organizationId: 'org',
        reservationId: first.reservation.id,
        actualUsd: 4.5,
        usage: {
          scopeType: 'ORGANIZATION',
          scopeKey: 'org',
          inputTokens: 100,
          outputTokens: 50,
        },
        traceId: 'trace-billing-1',
      });
      expect(settled.reservation.status).toBe('SETTLED');
      expect(settled.cost.amountUsd).toBe(4.5);
      expect(settled.cost.traceId).toBe('trace-billing-1');
      await expect(engine.listUsage('org')).resolves.toMatchObject({
        items: [expect.objectContaining({ traceId: 'trace-billing-1' })],
      });
      const budgets = await engine.listBudgets('org');
      expect(budgets.items[0]).toMatchObject({ id: budget.id, spentUsd: 4.5, reservedUsd: 0 });
      await expect(
        engine.settle({
          organizationId: 'org',
          reservationId: first.reservation.id,
          actualUsd: 1,
          usage: { scopeType: 'ORGANIZATION', scopeKey: 'org', inputTokens: 1, outputTokens: 1 },
        }),
      ).rejects.toThrow(/not active/);
    } finally {
      await adapter.close();
    }
  });

  it('supports soft warning and custom period validation', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const engine = new BudgetEngine(adapter, () => new Date('2026-09-09T12:00:00Z'));
      await expect(
        engine.createBudget({
          organizationId: 'org',
          scope: { type: 'USER', key: 'u' },
          period: 'CUSTOM',
          strategy: 'SOFT_LIMIT',
          limitUsd: 1,
          customStart: new Date('2026-09-10T00:00:00Z'),
          customEnd: new Date('2026-09-09T00:00:00Z'),
        }),
      ).rejects.toThrow(/CUSTOM/);
      await engine.createBudget({
        organizationId: 'org',
        scope: { type: 'USER', key: 'u' },
        period: 'DAILY',
        strategy: 'SOFT_LIMIT',
        limitUsd: 1,
      });
      const result = await engine.reserve({
        organizationId: 'org',
        principalId: 'u',
        idempotencyKey: 'soft-1',
        estimateUsd: 2,
        scopes: [{ type: 'USER', key: 'u' }],
      });
      expect(result.warnings).toHaveLength(1);
    } finally {
      await adapter.close();
    }
  });
});

describe('PricingCatalog', () => {
  it('resolves effective model pricing and computes token cost', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const catalog = new PricingCatalog(adapter);
      await catalog.setModelPricing({
        organizationId: 'org',
        provider: 'provider',
        model: 'model',
        currency: 'USD',
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      });
      await expect(
        catalog.costForTokens(
          'org',
          'provider',
          'model',
          500_000,
          250_000,
          new Date('2026-02-01T00:00:00Z'),
        ),
      ).resolves.toBe(1);
      await expect(catalog.costForTokens('org', 'provider', 'unknown', 1, 1)).rejects.toThrow(
        /pricing/i,
      );
    } finally {
      await adapter.close();
    }
  });
});
