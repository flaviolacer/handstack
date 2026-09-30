import type { DatabaseAdapter } from '@handstack/database';
import { repositoryName, uuidV7, type Repository, type TenantEntity } from '@handstack/domain';
import { BudgetExceededError, ValidationError } from '@handstack/shared';

export type BudgetScopeType =
  | 'ORGANIZATION'
  | 'GROUP'
  | 'USER'
  | 'API_KEY'
  | 'APPLICATION'
  | 'AGENT'
  | 'MODEL'
  | 'PROVIDER'
  | 'CAPABILITY';
export type BudgetPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
export type BudgetStrategy = 'HARD_LIMIT' | 'SOFT_LIMIT' | 'ALERT_ONLY';
export type ReservationStatus = 'RESERVED' | 'SETTLED' | 'RELEASED';

export interface Budget extends TenantEntity {
  readonly organizationId: string;
  readonly scopeType: BudgetScopeType;
  readonly scopeKey: string;
  readonly period: BudgetPeriod;
  readonly strategy: BudgetStrategy;
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly windowStartsAt: Date;
  readonly windowEndsAt: Date;
}

export interface BudgetReservation extends TenantEntity {
  readonly organizationId: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly estimatedUsd: number;
  readonly actualUsd?: number;
  readonly status: ReservationStatus;
  readonly budgetIds: readonly string[];
}

export interface UsageRecord extends TenantEntity {
  readonly organizationId: string;
  readonly reservationId: string;
  readonly principalId: string;
  readonly scopeType: BudgetScopeType;
  readonly scopeKey: string;
  readonly model?: string;
  readonly provider?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly traceId?: string;
}

export interface CostRecord extends TenantEntity {
  readonly organizationId: string;
  readonly reservationId: string;
  readonly amountUsd: number;
  readonly currency: 'USD';
  readonly source: 'MODEL' | 'TOOL' | 'CAPABILITY';
  readonly traceId?: string;
}

export interface ProviderPricing extends TenantEntity {
  readonly organizationId: string;
  readonly provider: string;
  readonly currency: 'USD';
  readonly inputUsdPerMillionTokens: number;
  readonly outputUsdPerMillionTokens: number;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
}

export interface ModelPricing extends TenantEntity {
  readonly organizationId: string;
  readonly provider: string;
  readonly model: string;
  readonly currency: 'USD';
  readonly inputUsdPerMillionTokens: number;
  readonly outputUsdPerMillionTokens: number;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
}

export interface BudgetScope {
  readonly type: BudgetScopeType;
  readonly key: string;
}

export interface ReservationResult {
  readonly reservation: BudgetReservation;
  readonly warnings: readonly string[];
}

const repositories = {
  budgets: repositoryName('budgets'),
  reservations: repositoryName('budget-reservations'),
  usage: repositoryName('usage-records'),
  costs: repositoryName('cost-records'),
  providerPricing: repositoryName('provider-pricing'),
  modelPricing: repositoryName('model-pricing'),
} as const;

export const budgetsSchema = { version: 1, repositories } as const;

function assertMoney(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000)
    throw new ValidationError(`${name} must be a finite non-negative USD amount`);
}

function windowFor(period: BudgetPeriod, now: Date, customStart?: Date, customEnd?: Date) {
  const start = new Date(now);
  if (period === 'DAILY') start.setUTCHours(0, 0, 0, 0);
  else if (period === 'WEEKLY') {
    start.setUTCHours(0, 0, 0, 0);
    const day = start.getUTCDay();
    start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
  } else if (period === 'MONTHLY') {
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(1);
  } else {
    if (customStart === undefined || customEnd === undefined || customEnd <= customStart)
      throw new ValidationError('CUSTOM budget requires a valid window');
    return { start: new Date(customStart), end: new Date(customEnd) };
  }
  const end = new Date(start);
  if (period === 'DAILY') end.setUTCDate(end.getUTCDate() + 1);
  else if (period === 'WEEKLY') end.setUTCDate(end.getUTCDate() + 7);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}

async function all<T extends TenantEntity>(repository: Repository<T>, organizationId: string) {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list(organizationId, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

export class BudgetEngine {
  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createBudget(input: {
    organizationId: string;
    scope: BudgetScope;
    period: BudgetPeriod;
    strategy: BudgetStrategy;
    limitUsd: number;
    customStart?: Date;
    customEnd?: Date;
  }): Promise<Budget> {
    if (input.organizationId === '' || input.scope.key === '')
      throw new ValidationError('Budget organization and scope are required');
    assertMoney(input.limitUsd, 'limitUsd');
    const timestamp = this.now();
    const window = windowFor(input.period, timestamp, input.customStart, input.customEnd);
    return this.adapter.repository<Budget>(repositories.budgets).insert({
      id: uuidV7(timestamp.getTime()),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      scopeType: input.scope.type,
      scopeKey: input.scope.key,
      period: input.period,
      strategy: input.strategy,
      limitUsd: input.limitUsd,
      spentUsd: 0,
      reservedUsd: 0,
      windowStartsAt: window.start,
      windowEndsAt: window.end,
    });
  }

  listBudgets(organizationId: string) {
    return this.adapter
      .repository<Budget>(repositories.budgets)
      .list(organizationId, { limit: 100 });
  }

  listUsage(organizationId: string) {
    return this.adapter
      .repository<UsageRecord>(repositories.usage)
      .list(organizationId, { limit: 100 });
  }

  listCosts(organizationId: string) {
    return this.adapter
      .repository<CostRecord>(repositories.costs)
      .list(organizationId, { limit: 100 });
  }

  async reserve(input: {
    organizationId: string;
    principalId: string;
    idempotencyKey: string;
    estimateUsd: number;
    scopes: readonly BudgetScope[];
  }): Promise<ReservationResult> {
    assertMoney(input.estimateUsd, 'estimateUsd');
    if (input.idempotencyKey.trim() === '' || input.principalId === '')
      throw new ValidationError('Reservation principal and idempotency key are required');
    const timestamp = this.now();
    return this.adapter.run(
      async (context) => {
        const budgets = context.repository<Budget>(repositories.budgets);
        const reservations = context.repository<BudgetReservation>(repositories.reservations);
        const existing = await all(reservations, input.organizationId);
        const prior = existing.find(
          (item) =>
            item.idempotencyKey === input.idempotencyKey && item.principalId === input.principalId,
        );
        if (prior !== undefined) return { reservation: prior, warnings: [] };
        const candidates = (await all(budgets, input.organizationId)).filter(
          (budget) =>
            input.scopes.some(
              (scope) => scope.type === budget.scopeType && scope.key === budget.scopeKey,
            ) &&
            new Date(budget.windowStartsAt) <= timestamp &&
            new Date(budget.windowEndsAt) > timestamp,
        );
        const warnings: string[] = [];
        const selected: Budget[] = [];
        for (const budget of candidates) {
          const available = budget.limitUsd - budget.spentUsd - budget.reservedUsd;
          if (budget.strategy === 'HARD_LIMIT' && available < input.estimateUsd)
            throw new BudgetExceededError('Budget reservation exceeds a hard limit');
          if (budget.strategy === 'SOFT_LIMIT' && available < input.estimateUsd)
            warnings.push(`Budget ${budget.id} soft limit exceeded`);
          selected.push(budget);
        }
        const reservation: BudgetReservation = {
          id: uuidV7(timestamp.getTime()),
          tenantId: input.organizationId,
          organizationId: input.organizationId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          principalId: input.principalId,
          idempotencyKey: input.idempotencyKey,
          estimatedUsd: input.estimateUsd,
          status: 'RESERVED',
          budgetIds: selected.map((budget) => budget.id),
        };
        for (const budget of selected)
          await budgets.update(
            {
              ...budget,
              version: budget.version + 1,
              updatedAt: timestamp,
              reservedUsd: budget.reservedUsd + input.estimateUsd,
            },
            budget.version,
          );
        await reservations.insert(reservation);
        return { reservation, warnings };
      },
      { isolation: 'serializable' },
    );
  }

  async settle(input: {
    organizationId: string;
    reservationId: string;
    actualUsd: number;
    usage: Omit<
      UsageRecord,
      keyof TenantEntity | 'organizationId' | 'reservationId' | 'principalId' | 'costUsd'
    > & { scopeType: BudgetScopeType; scopeKey: string };
    source?: CostRecord['source'];
    traceId?: string;
  }): Promise<{ reservation: BudgetReservation; cost: CostRecord }> {
    assertMoney(input.actualUsd, 'actualUsd');
    const timestamp = this.now();
    return this.adapter.run(
      async (context) => {
        const reservations = context.repository<BudgetReservation>(repositories.reservations);
        const reservation = await reservations.findById(input.organizationId, input.reservationId);
        if (reservation === undefined) throw new ValidationError('Budget reservation not found');
        if (reservation.status !== 'RESERVED')
          throw new ValidationError('Budget reservation is not active');
        const budgets = context.repository<Budget>(repositories.budgets);
        for (const budgetId of reservation.budgetIds) {
          const budget = await budgets.findById(input.organizationId, budgetId);
          if (budget === undefined)
            throw new ValidationError('Budget reservation references a missing budget');
          await budgets.update(
            {
              ...budget,
              version: budget.version + 1,
              updatedAt: timestamp,
              reservedUsd: Math.max(0, budget.reservedUsd - reservation.estimatedUsd),
              spentUsd: budget.spentUsd + input.actualUsd,
            },
            budget.version,
          );
        }
        const settled: BudgetReservation = {
          ...reservation,
          version: reservation.version + 1,
          updatedAt: timestamp,
          actualUsd: input.actualUsd,
          status: 'SETTLED',
        };
        await reservations.update(settled, reservation.version);
        const cost: CostRecord = {
          id: uuidV7(timestamp.getTime()),
          tenantId: input.organizationId,
          organizationId: input.organizationId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          reservationId: reservation.id,
          amountUsd: input.actualUsd,
          currency: 'USD',
          source: input.source ?? 'MODEL',
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        };
        await context.repository<UsageRecord>(repositories.usage).insert({
          id: uuidV7(timestamp.getTime() + 1),
          tenantId: input.organizationId,
          organizationId: input.organizationId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          reservationId: reservation.id,
          ...input.usage,
          principalId: reservation.principalId,
          costUsd: input.actualUsd,
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        });
        await context.repository<CostRecord>(repositories.costs).insert(cost);
        return { reservation: settled, cost };
      },
      { isolation: 'serializable' },
    );
  }
}

export class PricingCatalog {
  constructor(private readonly adapter: DatabaseAdapter) {}

  listModelPricing(organizationId: string) {
    return this.adapter
      .repository<ModelPricing>(repositories.modelPricing)
      .list(organizationId, { limit: 100 });
  }

  async setModelPricing(input: Omit<ModelPricing, keyof TenantEntity>): Promise<ModelPricing> {
    assertMoney(input.inputUsdPerMillionTokens, 'inputUsdPerMillionTokens');
    assertMoney(input.outputUsdPerMillionTokens, 'outputUsdPerMillionTokens');
    if (input.effectiveTo !== undefined && input.effectiveTo <= input.effectiveFrom)
      throw new ValidationError('effectiveTo must be after effectiveFrom');
    const timestamp = new Date();
    return this.adapter.repository<ModelPricing>(repositories.modelPricing).insert({
      ...input,
      id: uuidV7(timestamp.getTime()),
      tenantId: input.organizationId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async resolveModelPricing(
    organizationId: string,
    provider: string,
    model: string,
    at = new Date(),
  ) {
    const page = await this.adapter
      .repository<ModelPricing>(repositories.modelPricing)
      .list(organizationId, { limit: 100 });
    return page.items
      .filter((item) => {
        const from = new Date(item.effectiveFrom);
        const to = item.effectiveTo === undefined ? undefined : new Date(item.effectiveTo);
        return (
          item.provider === provider &&
          item.model === model &&
          from <= at &&
          (to === undefined || to > at)
        );
      })
      .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())[0];
  }

  async costForTokens(
    organizationId: string,
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    at = new Date(),
  ) {
    if (
      !Number.isInteger(inputTokens) ||
      inputTokens < 0 ||
      !Number.isInteger(outputTokens) ||
      outputTokens < 0
    )
      throw new ValidationError('Token counts must be non-negative integers');
    const pricing = await this.resolveModelPricing(organizationId, provider, model, at);
    if (pricing === undefined) throw new ValidationError('No effective model pricing found');
    return (
      (inputTokens * pricing.inputUsdPerMillionTokens +
        outputTokens * pricing.outputUsdPerMillionTokens) /
      1_000_000
    );
  }
}
