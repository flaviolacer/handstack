import { ValidationError } from '@handstack/shared';

/**
 * Pricing is versioned by effective date. A provider or model may hold several immutable price
 * records over time; resolution always selects the latest record whose `effectiveFrom` is on or
 * before the requested instant, so historical cost accounting remains reproducible.
 */

export type PricingCurrency = 'USD' | 'EUR' | 'BRL';

/**
 * The six price dimensions required by the specification. All token prices are expressed per one
 * million tokens, image prices per image, audio prices per minute of audio, and request prices as a
 * flat amount per request.
 */
export interface PricingFields {
  readonly inputTokenPrice: number;
  readonly outputTokenPrice: number;
  readonly cachedInputPrice: number;
  readonly imagePrice: number;
  readonly audioPrice: number;
  readonly requestPrice: number;
}

/** A versioned provider-level price record. */
export interface ProviderPricing {
  readonly organizationId: string;
  readonly providerId: string;
  readonly effectiveFrom: Date;
  readonly currency: PricingCurrency;
  readonly fields: PricingFields;
}

/** A versioned model-level price record, bound to a provider within the same organization. */
export interface ModelPricing {
  readonly organizationId: string;
  readonly modelDefinitionId: string;
  readonly providerId: string;
  readonly effectiveFrom: Date;
  readonly currency: PricingCurrency;
  readonly fields: PricingFields;
}

/** The measurable quantities charged against a price record. */
export interface CostUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly images: number;
  readonly audioMinutes: number;
  readonly requests: number;
}

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Computes the total cost of a usage sample against a price record. Token quantities are divided by
 * one million before multiplication so the caller always supplies raw token counts.
 */
export function estimateCost(fields: PricingFields, usage: CostUsage): number {
  validateUsage(usage);
  const tokenCost =
    (fields.inputTokenPrice * usage.inputTokens +
      fields.outputTokenPrice * usage.outputTokens +
      fields.cachedInputPrice * usage.cachedInputTokens) /
    TOKENS_PER_MILLION;
  const mediaCost = fields.imagePrice * usage.images + fields.audioPrice * usage.audioMinutes;
  const requestCost = fields.requestPrice * usage.requests;
  return roundCurrency(tokenCost + mediaCost + requestCost);
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

/** Creates a validated provider pricing record, defaulting the currency to USD. */
export function createProviderPricing(input: {
  readonly organizationId: string;
  readonly providerId: string;
  readonly effectiveFrom: Date;
  readonly currency?: PricingCurrency;
  readonly fields: PricingFields;
}): ProviderPricing {
  validateTenant(input.organizationId, 'organizationId');
  if (input.providerId === '') throw new ValidationError('Provider pricing providerId is required');
  validateFields(input.fields);
  return {
    organizationId: input.organizationId,
    providerId: input.providerId,
    effectiveFrom: input.effectiveFrom,
    currency: input.currency ?? 'USD',
    fields: { ...input.fields },
  };
}

/** Creates a validated model pricing record, defaulting the currency to USD. */
export function createModelPricing(input: {
  readonly organizationId: string;
  readonly modelDefinitionId: string;
  readonly providerId: string;
  readonly effectiveFrom: Date;
  readonly currency?: PricingCurrency;
  readonly fields: PricingFields;
}): ModelPricing {
  validateTenant(input.organizationId, 'organizationId');
  if (input.modelDefinitionId === '')
    throw new ValidationError('Model pricing modelDefinitionId is required');
  if (input.providerId === '') throw new ValidationError('Model pricing providerId is required');
  validateFields(input.fields);
  return {
    organizationId: input.organizationId,
    modelDefinitionId: input.modelDefinitionId,
    providerId: input.providerId,
    effectiveFrom: input.effectiveFrom,
    currency: input.currency ?? 'USD',
    fields: { ...input.fields },
  };
}

/**
 * Tenant-scoped versioned pricing registry. Records are append-only in the sense that registering a
 * newer effective date adds a version rather than mutating an older one; resolution never crosses
 * organization boundaries.
 */
export class PricingService {
  private readonly providers: ProviderPricing[] = [];
  private readonly models: ModelPricing[] = [];

  registerProviderPricing(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly effectiveFrom: Date;
    readonly currency?: PricingCurrency;
    readonly fields: PricingFields;
  }): ProviderPricing {
    const record = createProviderPricing(input);
    if (
      this.providers.some(
        (item) =>
          item.organizationId === record.organizationId &&
          item.providerId === record.providerId &&
          item.effectiveFrom.getTime() === record.effectiveFrom.getTime(),
      )
    )
      throw new ValidationError('Provider pricing version already exists');
    this.providers.push(record);
    return record;
  }

  registerModelPricing(input: {
    readonly organizationId: string;
    readonly modelDefinitionId: string;
    readonly providerId: string;
    readonly effectiveFrom: Date;
    readonly currency?: PricingCurrency;
    readonly fields: PricingFields;
  }): ModelPricing {
    const record = createModelPricing(input);
    if (
      this.models.some(
        (item) =>
          item.organizationId === record.organizationId &&
          item.modelDefinitionId === record.modelDefinitionId &&
          item.effectiveFrom.getTime() === record.effectiveFrom.getTime(),
      )
    )
      throw new ValidationError('Model pricing version already exists');
    this.models.push(record);
    return record;
  }

  /** Returns the provider price effective on or before `at`, or `undefined` when none exists. */
  providerPricingAt(
    organizationId: string,
    providerId: string,
    at: Date,
  ): ProviderPricing | undefined {
    return latestBefore(this.providers.filter(byTenantAndProvider(organizationId, providerId)), at);
  }

  /** Returns the model price effective on or before `at`, or `undefined` when none exists. */
  modelPricingAt(
    organizationId: string,
    modelDefinitionId: string,
    at: Date,
  ): ModelPricing | undefined {
    return latestBefore(
      this.models.filter(byTenantAndModel(organizationId, modelDefinitionId)),
      at,
    );
  }

  /** Returns the most recent provider price regardless of effective date. */
  latestProviderPricing(organizationId: string, providerId: string): ProviderPricing | undefined {
    return latestBefore(
      this.providers.filter(byTenantAndProvider(organizationId, providerId)),
      null,
    );
  }

  /** Returns the most recent model price regardless of effective date. */
  latestModelPricing(organizationId: string, modelDefinitionId: string): ModelPricing | undefined {
    return latestBefore(
      this.models.filter(byTenantAndModel(organizationId, modelDefinitionId)),
      null,
    );
  }

  listProviderPricing(organizationId: string): readonly ProviderPricing[] {
    return this.providers
      .filter((record) => record.organizationId === organizationId)
      .slice()
      .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
  }

  listModelPricing(organizationId: string): readonly ModelPricing[] {
    return this.models
      .filter((record) => record.organizationId === organizationId)
      .slice()
      .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
  }

  /** Estimates the cost of a usage sample against the effective model price, or `undefined` when absent. */
  estimateModelCost(
    organizationId: string,
    modelDefinitionId: string,
    usage: CostUsage,
    at: Date,
  ): number | undefined {
    const pricing = this.modelPricingAt(organizationId, modelDefinitionId, at);
    return pricing === undefined ? undefined : estimateCost(pricing.fields, usage);
  }
}

function byTenantAndProvider(organizationId: string, providerId: string) {
  return (record: ProviderPricing): boolean =>
    record.organizationId === organizationId && record.providerId === providerId;
}

function byTenantAndModel(organizationId: string, modelDefinitionId: string) {
  return (record: ModelPricing): boolean =>
    record.organizationId === organizationId && record.modelDefinitionId === modelDefinitionId;
}

function latestBefore<T extends { readonly effectiveFrom: Date }>(
  records: readonly T[],
  at: Date | null,
): T | undefined {
  const sorted = records
    .slice()
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  if (at === null) return sorted[0];
  return sorted.find((record) => record.effectiveFrom.getTime() <= at.getTime());
}

function validateTenant(value: string, field: string): void {
  if (value === '') throw new ValidationError(`Pricing ${field} is required`);
}

function validateFields(fields: PricingFields): void {
  const prices: readonly [string, number][] = [
    ['inputTokenPrice', fields.inputTokenPrice],
    ['outputTokenPrice', fields.outputTokenPrice],
    ['cachedInputPrice', fields.cachedInputPrice],
    ['imagePrice', fields.imagePrice],
    ['audioPrice', fields.audioPrice],
    ['requestPrice', fields.requestPrice],
  ];
  for (const [name, value] of prices) {
    if (!Number.isFinite(value) || value < 0)
      throw new ValidationError(`Pricing field ${name} must be a non-negative number`);
  }
}

function validateUsage(usage: CostUsage): void {
  const values: readonly [string, number][] = [
    ['inputTokens', usage.inputTokens],
    ['outputTokens', usage.outputTokens],
    ['cachedInputTokens', usage.cachedInputTokens],
    ['images', usage.images],
    ['audioMinutes', usage.audioMinutes],
    ['requests', usage.requests],
  ];
  for (const [name, value] of values)
    if (!Number.isFinite(value) || value < 0)
      throw new ValidationError(`Pricing usage ${name} must be non-negative`);
}
