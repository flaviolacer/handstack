import { describe, expect, it } from 'vitest';
import { RateLimitError } from '@handstack/shared';
import {
  InMemoryRateLimitStore,
  raiseRateLimitError,
  ScopedRateLimiter,
  type RateLimitRule,
} from '../src/index.js';

describe('ScopedRateLimiter', () => {
  it('enforces an organization requests-per-minute rule and resets after the window', async () => {
    const limiter = new ScopedRateLimiter(
      new InMemoryRateLimitStore(),
      [{ scope: 'organization', scopeId: 'org-1', metric: 'requests_per_minute', limit: 2 }],
      () => 0,
    );

    await expect(limiter.check({ organizationId: 'org-1' })).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    });
    await expect(limiter.check({ organizationId: 'org-1' })).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    const denied = await limiter.check({ organizationId: 'org-1' });
    expect(denied.allowed).toBe(false);
    expect(denied.exceededScope).toBe('organization');
    expect(denied.exceededMetric).toBe('requests_per_minute');
    try {
      raiseRateLimitError(denied);
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      if (error instanceof RateLimitError) expect(error.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('charges token deltas against a tokens-per-minute rule', async () => {
    const rule: RateLimitRule = {
      scope: 'user',
      scopeId: 'user-1',
      metric: 'tokens_per_minute',
      limit: 100,
    };
    const limiter = new ScopedRateLimiter(new InMemoryRateLimitStore(), [rule], () => 0);
    const context = { organizationId: 'org-1', userId: 'user-1', tokens: 60 };

    await expect(limiter.check(context)).resolves.toMatchObject({ allowed: true, remaining: 40 });
    await expect(limiter.check({ ...context, tokens: 50 })).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('enforces a daily_requests window independently of the minute window', async () => {
    const limiter = new ScopedRateLimiter(
      new InMemoryRateLimitStore(),
      [{ scope: 'api_key', scopeId: 'key-1', metric: 'daily_requests', limit: 1 }],
      () => DAY_MS + 1,
    );
    const context = { organizationId: 'org-1', apiKeyId: 'key-1' };

    await expect(limiter.check(context)).resolves.toMatchObject({ allowed: true });
    const denied = await limiter.check(context);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reserves and releases concurrency slots', async () => {
    const limiter = new ScopedRateLimiter(
      new InMemoryRateLimitStore(),
      [{ scope: 'agent', scopeId: 'agent-1', metric: 'concurrent_requests', limit: 1 }],
      () => 0,
    );
    const context = { organizationId: 'org-1', agentId: 'agent-1' };

    await expect(limiter.acquire(context)).resolves.toMatchObject({ allowed: true });
    await expect(limiter.acquire(context)).resolves.toMatchObject({ allowed: false });
    await limiter.release(context);
    await expect(limiter.acquire(context)).resolves.toMatchObject({ allowed: true });
  });

  it('keeps tenants isolated so a rule never consumes another organization capacity', async () => {
    const limiter = new ScopedRateLimiter(
      new InMemoryRateLimitStore(),
      [{ scope: 'organization', scopeId: 'org-1', metric: 'requests_per_minute', limit: 1 }],
      () => 0,
    );
    await limiter.check({ organizationId: 'org-1' });
    await expect(limiter.check({ organizationId: 'org-2' })).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('scopes are keyed independently within the same tenant', async () => {
    const limiter = new ScopedRateLimiter(
      new InMemoryRateLimitStore(),
      [
        { scope: 'model', scopeId: 'model-a', metric: 'requests_per_minute', limit: 1 },
        { scope: 'model', scopeId: 'model-b', metric: 'requests_per_minute', limit: 1 },
      ],
      () => 0,
    );
    await limiter.check({ organizationId: 'org-1', modelId: 'model-a' });
    await expect(
      limiter.check({ organizationId: 'org-1', modelId: 'model-b' }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('rejects an empty organization and an invalid rule limit', () => {
    const limiter = new ScopedRateLimiter();
    expect(() => limiter.check({ organizationId: '' })).toThrow(RateLimitError);
    expect(() => {
      limiter.addRule({ scope: 'group', scopeId: 'g-1', metric: 'requests_per_minute', limit: -1 });
    }).toThrow(RateLimitError);
  });
});

const DAY_MS = 86_400_000;
