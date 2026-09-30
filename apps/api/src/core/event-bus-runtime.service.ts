import { Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import {
  InProcessEventBus,
  RedisStreamsEventBus,
  RedisStreamsTransportAdapter,
  type DomainEvent,
  type DomainEventHandler,
  type EventBus,
  type RedisStreamsClient,
} from '@handstack/core';
import { RedisAuditAppendCoordinator, type AuditAppendCoordinator } from '@handstack/audit';
import type { SubjectCacheRedisClient } from '@handstack/privacy';
import { Cluster, Redis, type RedisOptions } from 'ioredis';
import { DatabaseService } from '../database/database.service.js';

type RedisClient = Redis | Cluster;

/** Application boundary selecting the durable bus only for distributed deployments. */
@Injectable()
export class EventBusRuntimeService implements OnModuleDestroy {
  readonly bus: EventBus;
  readonly auditAppendCoordinator: AuditAppendCoordinator | undefined;
  readonly subjectCache: SubjectCacheRedisClient | undefined;
  private readonly client: RedisClient | undefined;

  constructor(@Optional() database?: DatabaseService) {
    const config = database?.config;
    if (config?.deployment.profile !== 'distributed' || config.queue.redisUrl === undefined) {
      this.bus = new InProcessEventBus();
      this.auditAppendCoordinator = undefined;
      this.subjectCache = undefined;
      return;
    }
    const client = createRedisClient(config.queue.redisUrl, config.queue.topology);
    this.client = client;
    this.subjectCache = {
      set: (key, value) => client.set(key, value),
      get: async (key) => (await client.get(key)) ?? null,
      sadd: (key, member) => client.sadd(key, member),
      srem: (key, member) => client.srem(key, member),
      smembers: (key) => client.smembers(key),
      del: (...keys) => client.del(...keys),
    };
    this.auditAppendCoordinator = new RedisAuditAppendCoordinator(
      {
        set: async (key, value, ...options) => {
          const result = await client.call('SET', key, value, ...options);
          return result === 'OK' ? 'OK' : null;
        },
        eval: (script, numberOfKeys, ...arguments_) =>
          client.eval(script, numberOfKeys, ...arguments_),
      },
      { keyPrefix: `${config.queue.namespaces.queues}:audit-lock` },
    );
    this.bus = new RedisStreamsEventBus(
      new RedisStreamsTransportAdapter(redisStreamsClient(this.client)),
      {
        streamPrefix: `${config.queue.namespaces.streams}:events`,
        pendingClaimIdleMs: config.queue.pendingClaimIdleMs,
      },
    );
  }

  publish(event: DomainEvent): Promise<void> {
    return this.bus.publish(event);
  }

  subscribe(eventType: string, handler: DomainEventHandler): () => void {
    return this.bus.subscribe(eventType, handler);
  }

  consumeOnce(eventType: string): Promise<number> {
    if (!(this.bus instanceof RedisStreamsEventBus)) return Promise.resolve(0);
    return this.bus.consumeOnce(eventType);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.bus instanceof RedisStreamsEventBus) this.bus.close();
    await this.client?.quit();
  }
}

function redisStreamsClient(client: RedisClient): RedisStreamsClient {
  const command = client as unknown as RedisCommandClient;
  return {
    xadd: async (stream, id, fields) =>
      String(
        await command.call(
          'XADD',
          stream,
          id,
          ...Object.entries(fields).flatMap(([key, value]) => [key, value]),
        ),
      ),
    xgroupCreate: async (stream, group, id, createStream) => {
      await command.call(
        'XGROUP',
        'CREATE',
        stream,
        group,
        id,
        ...(createStream ? ['MKSTREAM'] : []),
      );
    },
    xreadgroup: async (group, consumer, stream, count) => {
      const raw = await command.call(
        'XREADGROUP',
        'GROUP',
        group,
        consumer,
        'COUNT',
        String(count),
        'STREAMS',
        stream,
        '>',
      );
      const response = Array.isArray(raw) ? raw : [];
      const streamResult = Array.isArray(response[0]) ? response[0] : [];
      const entries = Array.isArray(streamResult[1]) ? streamResult[1] : [];
      return entries.flatMap((entry) => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1]))
          return [];
        return [
          {
            id: entry[0],
            fields: pairsToRecord(
              entry[1].filter((value): value is string => typeof value === 'string'),
            ),
            deliveries: 1,
          },
        ];
      });
    },
    xautoclaim: async (stream, group, consumer, minIdleMs, startId, count) => {
      const raw = await command.call(
        'XAUTOCLAIM',
        stream,
        group,
        consumer,
        String(minIdleMs),
        startId,
        'COUNT',
        String(count),
      );
      const response = Array.isArray(raw) ? raw : [];
      const nextStartId = typeof response[0] === 'string' ? response[0] : '0-0';
      const rawEntries = Array.isArray(response[1]) ? response[1] : [];
      const entries = [];
      for (const entry of rawEntries) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1]))
          continue;
        const id = entry[0];
        const fields = pairsToRecord(
          entry[1].filter((value): value is string => typeof value === 'string'),
        );
        const pending = await command.call('XPENDING', stream, group, id, id, '1');
        const pendingRows: unknown[] =
          Array.isArray(pending) && Array.isArray(pending[0]) ? (pending[0] as unknown[]) : [];
        const firstPending = pendingRows[0] as unknown[] | undefined;
        const deliveries = Number(firstPending?.[3] ?? 1);
        entries.push({ id, fields, deliveries: Number.isInteger(deliveries) ? deliveries : 1 });
      }
      return { nextStartId, entries };
    },
    xack: async (stream, group, id) => {
      await command.call('XACK', stream, group, id);
    },
  };
}

interface RedisCommandClient {
  call(...args: readonly string[]): Promise<unknown>;
}

function pairsToRecord(values: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (let index = 0; index + 1 < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key !== undefined && value !== undefined) result[key] = value;
  }
  return result;
}

function createRedisClient(
  redisUrl: string,
  topology: 'standalone' | 'sentinel' | 'cluster',
): RedisClient {
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
  if (topology === 'standalone') return new Redis(options);
  if (topology === 'sentinel')
    return new Redis({
      ...options,
      sentinels: [{ host: url.hostname, port }],
      name: url.searchParams.get('master') ?? 'mymaster',
    });
  return new Cluster([{ host: url.hostname, port }], { redisOptions: options });
}
