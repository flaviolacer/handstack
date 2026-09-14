import { describe, expect, it } from 'vitest';
import {
  ModelRouter,
  RoutingError,
  validateRoutingPolicy,
  type RoutingPolicy,
} from '../src/index.js';

const policy = (strategy: RoutingPolicy['strategy']): RoutingPolicy => ({
  organizationId: 'org-1',
  id: `policy-${strategy}`,
  name: 'primary',
  strategy,
  candidates: [
    {
      modelDefinitionId: 'cheap',
      providerId: 'p1',
      priority: 2,
      weight: 1,
      costUsdPerRequest: 0.01,
      latencyMs: 300,
      tags: ['chat'],
    },
    {
      modelDefinitionId: 'fast',
      providerId: 'p2',
      priority: 1,
      weight: 3,
      costUsdPerRequest: 0.04,
      latencyMs: 80,
      tags: ['chat', 'fast'],
    },
  ],
});

describe('ModelRouter', () => {
  it('supports fallback, cost, latency and round robin strategies', () => {
    const router = new ModelRouter();
    expect(
      router.route({ organizationId: 'org-1', policy: policy('fallback') }).candidate
        .modelDefinitionId,
    ).toBe('cheap');
    expect(
      router.route({ organizationId: 'org-1', policy: policy('least_cost') }).candidate
        .modelDefinitionId,
    ).toBe('cheap');
    expect(
      router.route({ organizationId: 'org-1', policy: policy('least_latency') }).candidate
        .modelDefinitionId,
    ).toBe('fast');
    expect(
      router.route({ organizationId: 'org-1', policy: policy('round_robin') }).candidate
        .modelDefinitionId,
    ).toBe('cheap');
    expect(
      router.route({ organizationId: 'org-1', policy: policy('round_robin') }).candidate
        .modelDefinitionId,
    ).toBe('fast');
  });

  it('filters disabled/tagged candidates and supports weighted/custom routing', () => {
    const router = new ModelRouter();
    const weighted = router.route({
      organizationId: 'org-1',
      policy: policy('weighted'),
      random: () => 0.9,
    });
    expect(weighted.candidate.modelDefinitionId).toBe('fast');
    expect(
      router.route({
        organizationId: 'org-1',
        policy: policy('semantic'),
        requiredTags: ['fast'],
        score: (c) => c.latencyMs ?? 0,
      }).candidate.modelDefinitionId,
    ).toBe('fast');
    expect(() => router.route({ organizationId: 'org-1', policy: policy('custom') })).toThrowError(
      RoutingError,
    );
  });

  it('fails closed for invalid scope and policies', () => {
    expect(() => {
      validateRoutingPolicy({ ...policy('priority'), candidates: [] });
    }).toThrow();
    expect(() =>
      new ModelRouter().route({ organizationId: 'org-2', policy: policy('priority') }),
    ).toThrow();
    expect(() =>
      new ModelRouter().route({
        organizationId: 'org-1',
        policy: {
          ...policy('priority'),
          candidates: [{ modelDefinitionId: 'disabled', providerId: 'p1', enabled: false }],
        },
      }),
    ).toThrowError(RoutingError);
  });
});
