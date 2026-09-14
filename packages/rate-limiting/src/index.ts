import { RateLimitError } from '@handstack/shared';

/**
 * The tenant-owned or platform-wide dimension a rate limit is scoped to. Every rule is keyed by
 * `scope` + `scopeId` + `organizationId`, so a limit configured for one tenant can never consume
 * capacity from another tenant.
 */
export type RateLimitScope =
  'organization' | 'group' | 'user' | 'api_key' | 'agent' | 'model' | 'capability';

/** The measurable quantity a rule constrains. */
export type RateLimitMetric =
  'requests_per_minute' | 'tokens_per_minute' | 'concurrent_requests' | 'daily_requests';

/** One immutable rate limit rule: `limit` units of `metric` per window for a single scope. */
export interface RateLimitRule {
  readonly scope: RateLimitScope;
  /** The identifier of the scoped entity, for example a group id or model id. */
  readonly scopeId: string;
  readonly metric: RateLimitMetric;
  /** Non-negative integer limit. Concurrent limits count in-flight executions; others count per window. */
  readonly limit: number;
}

/** The runtime identity of a request against which matching rules are evaluated. */
export interface RateLimitContext {
  readonly organizationId: string;
  readonly groupId?: string;
  readonly userId?: string;
  readonly apiKeyId?: string;
  readonly agentId?: string;
  readonly modelId?: string;
  readonly capabilityId?: string;
  /** Token delta to charge against `tokens_per_minute` rules. Defaults to zero. */
  readonly tokens?: number;
}

/** The outcome of a rate-limit evaluation. */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Units remaining in the window for the most-constrained matching rule. */
  readonly remaining: number;
  /** When the most-constrained window resets. */
  readonly resetAt: Date;
  /** Seconds until the window resets, when the decision is a denial. */
  readonly retryAfterSeconds: number;
  readonly exceededScope?: RateLimitScope;
  readonly exceededMetric?: RateLimitMetric;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const SCOPE_FIELD: Readonly<Record<RateLimitScope, keyof RateLimitContext>> = {
  organization: 'organizationId',
  group: 'groupId',
  user: 'userId',
  api_key: 'apiKeyId',
  agent: 'agentId',
  model: 'modelId',
  capability: 'capabilityId',
};

/**
 * Storage behind the limiter. The in-memory implementation is the official default for the compact
 * profile; a Redis-backed implementation provides cross-replica coordination in the distributed
 * profile without changing the limiter's contract.
 */
export interface RateLimitStore {
  /**
   * Atomically increments the counter identified by `key` within `windowStart` by `amount` and
   * reports whether the result stays within `limit`. Implementations must be safe under concurrency
   * for the same key.
   */
  consume(
    key: string,
    windowStart: number,
    amount: number,
    limit: number,
  ): Promise<{ count: number; allowed: boolean; resetAt: number }>;
  /** Atomically reserves one concurrency slot, failing when `limit` is already reached. */
  acquireSlot(key: string, limit: number): Promise<{ inFlight: number; allowed: boolean }>;
  /** Releases one previously acquired concurrency slot. */
  releaseSlot(key: string): Promise<void>;
}

/** Default in-memory store backed by per-key counters, safe for the compact single-process profile. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, { windowStart: number; count: number }>();
  private readonly slots = new Map<string, number>();

  consume(key: string, windowStart: number, amount: number, limit: number) {
    const current = this.counters.get(key);
    const count = current?.windowStart === windowStart ? current.count + amount : amount;
    this.counters.set(key, { windowStart, count });
    const resetAt = (windowStart + 1) * this.windowMs(key);
    return Promise.resolve({ count, allowed: count <= limit, resetAt });
  }

  acquireSlot(key: string, limit: number) {
    const inFlight = this.slots.get(key) ?? 0;
    const allowed = inFlight < limit;
    if (allowed) this.slots.set(key, inFlight + 1);
    return Promise.resolve({ inFlight, allowed });
  }

  releaseSlot(key: string) {
    const inFlight = this.slots.get(key) ?? 0;
    if (inFlight > 0) this.slots.set(key, inFlight - 1);
    return Promise.resolve();
  }

  private windowMs(key: string): number {
    return key.includes(':daily_requests:') ? DAY_MS : MINUTE_MS;
  }
}

function windowStartFor(metric: RateLimitMetric, now: number): number {
  const window = metric === 'daily_requests' ? DAY_MS : MINUTE_MS;
  return Math.floor(now / window);
}

function scopeKey(organizationId: string, rule: RateLimitRule): string {
  return `${organizationId}:${rule.scope}:${rule.scopeId}`;
}

/**
 * Evaluates tenant-scoped rate limits across organization, group, user, API key, agent, model and
 * capability dimensions. Concurrency limits are handled explicitly through acquire/release; the
 * other metrics are windowed counters evaluated per request.
 */
export class ScopedRateLimiter {
  private readonly rules: RateLimitRule[] = [];

  constructor(
    private readonly store: RateLimitStore = new InMemoryRateLimitStore(),
    initialRules: readonly RateLimitRule[] = [],
    private readonly now: () => number = () => Date.now(),
  ) {
    for (const rule of initialRules) this.addRule(rule);
  }

  addRule(rule: RateLimitRule): void {
    validateRule(rule);
    this.rules.push(rule);
  }

  listRules(): readonly RateLimitRule[] {
    return [...this.rules];
  }

  /**
   * Charges a request against every matching windowed rule. When any rule is exceeded, the request
   * is denied and a typed {@link RateLimitError} describes the first exceeded dimension.
   */
  check(context: RateLimitContext): Promise<RateLimitDecision> {
    validateContext(context);
    return this.evaluate(context).then((decisions) => {
      const denial = decisions.find((decision) => !decision.allowed);
      if (denial !== undefined) return denial;
      const mostConstrained = decisions.reduce<RateLimitDecision | undefined>(
        (tightest, decision) => {
          if (tightest === undefined || decision.remaining < tightest.remaining) return decision;
          return tightest;
        },
        undefined,
      );
      return (
        mostConstrained ?? {
          allowed: true,
          remaining: Number.POSITIVE_INFINITY,
          resetAt: new Date(this.now()),
          retryAfterSeconds: 0,
        }
      );
    });
  }

  /** Reserves a concurrency slot for every matching `concurrent_requests` rule. */
  async acquire(context: RateLimitContext): Promise<RateLimitDecision> {
    validateContext(context);
    for (const rule of this.concurrencyRules(context)) {
      const key = `${scopeKey(context.organizationId, rule)}:concurrent`;
      const result = await this.store.acquireSlot(key, rule.limit);
      if (!result.allowed)
        return {
          allowed: false,
          remaining: 0,
          resetAt: new Date(this.now() + MINUTE_MS),
          retryAfterSeconds: 60,
          exceededScope: rule.scope,
          exceededMetric: rule.metric,
        };
    }
    return { allowed: true, remaining: 0, resetAt: new Date(this.now()), retryAfterSeconds: 0 };
  }

  /** Releases the concurrency slots previously acquired for a context. */
  async release(context: RateLimitContext): Promise<void> {
    for (const rule of this.concurrencyRules(context)) {
      const key = `${scopeKey(context.organizationId, rule)}:concurrent`;
      await this.store.releaseSlot(key);
    }
  }

  private matchingRules(context: RateLimitContext): readonly RateLimitRule[] {
    return this.rules.filter((rule) => {
      const field = SCOPE_FIELD[rule.scope];
      const value = context[field];
      return value !== undefined && rule.scopeId === value;
    });
  }

  private concurrencyRules(context: RateLimitContext): readonly RateLimitRule[] {
    return this.matchingRules(context).filter((rule) => rule.metric === 'concurrent_requests');
  }

  private async evaluate(context: RateLimitContext): Promise<readonly RateLimitDecision[]> {
    const now = this.now();
    const decisions: RateLimitDecision[] = [];
    for (const rule of this.matchingRules(context)) {
      if (rule.metric === 'concurrent_requests') continue;
      const windowStart = windowStartFor(rule.metric, now);
      const key = `${scopeKey(context.organizationId, rule)}:${rule.metric}:${String(windowStart)}`;
      const amount = rule.metric === 'tokens_per_minute' ? (context.tokens ?? 0) : 1;
      const result = await this.store.consume(key, windowStart, amount, rule.limit);
      const resetAt = new Date(result.resetAt);
      decisions.push({
        allowed: result.allowed,
        remaining: Math.max(0, rule.limit - result.count),
        resetAt,
        retryAfterSeconds: Math.max(0, Math.ceil((result.resetAt - now) / 1000)),
        ...(result.allowed ? {} : { exceededScope: rule.scope, exceededMetric: rule.metric }),
      });
    }
    return decisions;
  }
}

/** Throws a typed 429 error for a denied decision. */
export function raiseRateLimitError(decision: RateLimitDecision): never {
  const scope = decision.exceededScope ?? 'organization';
  const metric = decision.exceededMetric ?? 'requests_per_minute';
  throw new RateLimitError(
    `Rate limit exceeded for ${scope} (${metric}); retry after ${String(decision.retryAfterSeconds)}s`,
  );
}

function validateRule(rule: RateLimitRule): void {
  if (rule.scopeId === '') throw new RateLimitError('Rate limit rule scopeId is required');
  if (!Number.isSafeInteger(rule.limit) || rule.limit < 0)
    throw new RateLimitError('Rate limit rule limit must be a non-negative integer');
}

function validateContext(context: RateLimitContext): void {
  if (context.organizationId === '')
    throw new RateLimitError('Rate limit context organizationId is required');
}
