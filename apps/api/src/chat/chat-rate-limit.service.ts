import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Cluster, Redis, type RedisOptions } from 'ioredis';
import { RateLimitError } from '@handstack/shared';
import { DatabaseService } from '../database/database.service.js';

type RedisClient = Redis | Cluster;

/** Enforces the optional `rateLimits.chat` requests-per-minute organization limit. */
@Injectable()
export class ChatRateLimitService implements OnModuleDestroy {
  private readonly counters = new Map<string, { window: number; count: number }>();
  private redis: RedisClient | undefined;

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async consume(organizationId: string): Promise<void> {
    const limit = this.database.config.rateLimits.chat;
    if (limit === undefined) return;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('rateLimits.chat is invalid');

    const now = Date.now();
    const window = Math.floor(now / 60_000);
    const namespace = this.database.config.queue.namespaces.rateLimit;
    const key = `${namespace}:chat:${encodeURIComponent(organizationId)}:${String(window)}`;
    let count: number;
    if (this.database.config.deployment.profile === 'distributed') {
      const client = this.redisClient();
      count = Number(
        await client.eval(
          "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('PEXPIRE', KEYS[1], 61000) end; return count",
          1,
          key,
        ),
      );
    } else {
      const current = this.counters.get(key);
      count = current?.window === window ? current.count + 1 : 1;
      this.counters.set(key, { window, count });
      if (this.counters.size > 10_000) {
        for (const [entry, value] of this.counters)
          if (value.window < window) this.counters.delete(entry);
      }
    }
    if (count > limit)
      throw new RateLimitError(
        `Chat rate limit exceeded; retry after ${String(60 - Math.floor((now % 60_000) / 1000))}s`,
        60 - Math.floor((now % 60_000) / 1000),
      );
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit();
  }

  private redisClient(): RedisClient {
    if (this.redis !== undefined) return this.redis;
    const { redisUrl, topology } = this.database.config.queue;
    if (redisUrl === undefined)
      throw new Error('Distributed chat rate limiting requires queue.redisUrl');
    const url = new URL(redisUrl.replace(/^redis\+(?:sentinel|cluster):\/\//u, 'redis://'));
    const password = url.password === '' ? undefined : decodeURIComponent(url.password);
    const username = url.username === '' ? undefined : decodeURIComponent(url.username);
    const port = url.port === '' ? 6379 : Number(url.port);
    const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined;
    const options: RedisOptions = {
      host: url.hostname,
      port,
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      ...(db === undefined ? {} : { db }),
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    };
    this.redis =
      topology === 'standalone'
        ? new Redis(options)
        : topology === 'sentinel'
          ? new Redis({
              ...options,
              sentinels: [{ host: url.hostname, port }],
              name: url.searchParams.get('master') ?? 'mymaster',
            })
          : new Cluster([{ host: url.hostname, port }], { redisOptions: options });
    return this.redis;
  }
}
