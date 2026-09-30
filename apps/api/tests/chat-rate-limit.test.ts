import { RateLimitError } from '@handstack/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../src/database/database.service.js';
import { ChatRateLimitService } from '../src/chat/chat-rate-limit.service.js';

describe('ChatRateLimitService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enforces configured chat requests per organization and minute', async () => {
    const database = {
      config: {
        rateLimits: { chat: 1 },
        deployment: { profile: 'compact' },
        queue: { namespaces: { rateLimit: 'test-rate-limit' } },
      },
    } as unknown as DatabaseService;
    const service = new ChatRateLimitService(database);
    await service.consume('org-a');
    const limited = await service.consume('org-a').catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(RateLimitError);
    if (limited instanceof RateLimitError) expect(limited.retryAfterSeconds).toBeGreaterThan(0);
    await expect(service.consume('org-b')).resolves.toBeUndefined();
  });

  it('does not limit chat when no chat rate is configured', async () => {
    const database = {
      config: {
        rateLimits: {},
        deployment: { profile: 'compact' },
        queue: { namespaces: { rateLimit: 'test-rate-limit' } },
      },
    } as unknown as DatabaseService;
    const service = new ChatRateLimitService(database);
    await expect(service.consume('org-a')).resolves.toBeUndefined();
  });
});
