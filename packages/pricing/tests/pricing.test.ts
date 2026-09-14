import { describe, expect, it } from 'vitest';
import { ValidationError } from '@handstack/shared';
import { PricingService, estimateCost, type PricingFields } from '../src/index.js';

const fields: PricingFields = {
  inputTokenPrice: 2,
  outputTokenPrice: 4,
  cachedInputPrice: 1,
  imagePrice: 0.5,
  audioPrice: 0.25,
  requestPrice: 0.01,
};

describe('PricingService', () => {
  it('calculates all pricing dimensions and rounds currency', () => {
    expect(
      estimateCost(fields, {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cachedInputTokens: 100_000,
        images: 2,
        audioMinutes: 4,
        requests: 3,
      }),
    ).toBe(6.13);
  });

  it('resolves the latest version effective at a point in time per tenant', () => {
    const service = new PricingService();
    const oldDate = new Date('2026-01-01T00:00:00Z');
    const newDate = new Date('2026-06-01T00:00:00Z');
    service.registerModelPricing({
      organizationId: 'org-1',
      modelDefinitionId: 'm1',
      providerId: 'p1',
      effectiveFrom: oldDate,
      fields,
    });
    service.registerModelPricing({
      organizationId: 'org-1',
      modelDefinitionId: 'm1',
      providerId: 'p1',
      effectiveFrom: newDate,
      fields: { ...fields, inputTokenPrice: 9 },
    });
    expect(
      service.modelPricingAt('org-1', 'm1', new Date('2026-03-01T00:00:00Z'))?.fields
        .inputTokenPrice,
    ).toBe(2);
    expect(
      service.modelPricingAt('org-1', 'm1', new Date('2026-07-01T00:00:00Z'))?.fields
        .inputTokenPrice,
    ).toBe(9);
    expect(service.modelPricingAt('org-2', 'm1', newDate)).toBeUndefined();
    expect(
      service.estimateModelCost(
        'org-1',
        'm1',
        {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cachedInputTokens: 0,
          images: 0,
          audioMinutes: 0,
          requests: 0,
        },
        newDate,
      ),
    ).toBe(9);
  });

  it('rejects invalid fields, usage and duplicate effective versions', () => {
    expect(() =>
      estimateCost(fields, {
        inputTokens: -1,
        outputTokens: 0,
        cachedInputTokens: 0,
        images: 0,
        audioMinutes: 0,
        requests: 0,
      }),
    ).toThrowError(ValidationError);
    const service = new PricingService();
    const input = {
      organizationId: 'org-1',
      modelDefinitionId: 'm1',
      providerId: 'p1',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      fields,
    };
    service.registerModelPricing(input);
    expect(() => service.registerModelPricing(input)).toThrowError(ValidationError);
    expect(() =>
      service.registerProviderPricing({
        organizationId: '',
        providerId: 'p1',
        effectiveFrom: new Date(),
        fields,
      }),
    ).toThrowError(ValidationError);
  });
});
