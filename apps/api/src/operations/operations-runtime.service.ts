import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type ConnectionOptions, type RedisOptions } from 'bullmq';
import { Cluster } from 'ioredis';
import {
  InMemoryFeatureFlagService,
  type FeatureFlag,
  type FeatureFlagScope,
} from '@handstack/feature-flags';
import { repositoryName, type Repository, type TenantEntity } from '@handstack/domain';
import { ValidationError } from '@handstack/shared';
import {
  DistributedJobQueue,
  InMemoryJobQueue,
  RepositoryJobTransport,
  BullMqJobTransport,
  InMemoryOperationStore,
  RepositoryOperationStore,
  type Operation,
  type OperationStore,
  type JobQueueName,
  type BullMqQueue,
  JOB_QUEUES,
  type JobOptions,
} from '@handstack/jobs';
import { AuditRuntimeService } from '../audit/audit-runtime.service.js';
import { DatabaseService } from '../database/database.service.js';
import { listAllTenant } from '../database/pagination.js';
import { EventBusRuntimeService } from '../core/event-bus-runtime.service.js';
import type { DomainEventContext } from '@handstack/core';

@Injectable()
export class OperationsRuntimeService implements OnModuleDestroy {
  readonly flags = new InMemoryFeatureFlagService();
  readonly audit: AuditRuntimeService;
  readonly operations: OperationStore;
  private readonly queues = new Map<
    string,
    InMemoryJobQueue<unknown> | DistributedJobQueue<unknown>
  >();
  private readonly featureFlags: Repository<FeatureFlagEntity> | undefined;
  private readonly bullQueues = new Set<Queue>();

  constructor(
    @Inject(AuditRuntimeService) audit?: AuditRuntimeService,
    @Inject(DatabaseService) private readonly database?: DatabaseService,
    @Inject(EventBusRuntimeService) private readonly eventBus?: EventBusRuntimeService,
  ) {
    this.audit = audit ?? new AuditRuntimeService();
    this.featureFlags = database?.adapter.repository(repositoryName('feature-flags'));
    this.operations =
      database === undefined
        ? new InMemoryOperationStore()
        : new RepositoryOperationStore((repositoryName) =>
            database.adapter.repository(repositoryName),
          );
  }

  async listFeatureFlags(organizationId: string, userId: string): Promise<readonly FeatureFlag[]> {
    if (this.featureFlags === undefined) return this.flags.list({ organizationId, userId });
    const [global, scoped] = await Promise.all([
      listAllTenant(this.featureFlags, GLOBAL_TENANT),
      listAllTenant(this.featureFlags, organizationId),
    ]);
    return [...global, ...scoped]
      .map(entityToFeatureFlag)
      .filter(
        (flag) =>
          flag.scope === 'global' ||
          (flag.scope === 'organization' && flag.organizationId === organizationId) ||
          (flag.scope === 'user' &&
            flag.organizationId === organizationId &&
            flag.userId === userId),
      );
  }

  async setFeatureFlag(input: {
    key: string;
    scope: FeatureFlagScope;
    enabled: boolean;
    organizationId?: string;
    userId?: string;
  }): Promise<FeatureFlag> {
    const flag = this.flags.set(input);
    if (this.featureFlags === undefined) return flag;
    const tenantId =
      flag.scope === 'global' ? GLOBAL_TENANT : (flag.organizationId ?? GLOBAL_TENANT);
    const id = featureFlagId(flag);
    const existing = await this.featureFlags.findById(tenantId, id);
    const now = new Date();
    const entity: FeatureFlagEntity = {
      id,
      tenantId,
      version: existing?.version ?? 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      key: flag.key,
      scope: flag.scope,
      enabled: flag.enabled,
      ...(flag.organizationId === undefined ? {} : { organizationId: flag.organizationId }),
      ...(flag.userId === undefined ? {} : { userId: flag.userId }),
    };
    if (existing === undefined) await this.featureFlags.insert(entity);
    else
      await this.featureFlags.update(
        { ...entity, version: existing.version + 1 },
        existing.version,
      );
    return flag;
  }

  async createOperation(input: {
    organizationId: string;
    type: string;
    idempotencyKey: string;
    context?: DomainEventContext;
    result?: unknown;
  }) {
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey === '') throw new ValidationError('Idempotency key is required');
    const normalized = { ...input, idempotencyKey };
    const operation = await this.operations.create(normalized);
    await this.eventBus?.publish({
      id: `operation.created:${operation.id}`,
      type: 'operation.created',
      schemaVersion: 1,
      organizationId: operation.organizationId,
      timestamp: new Date().toISOString(),
      correlationId: operation.id,
      idempotencyKey: normalized.idempotencyKey,
      ...(input.context === undefined
        ? {}
        : { causationId: input.context.requestId, context: input.context }),
      payload: { operationId: operation.id, type: operation.type },
    });
    return operation;
  }

  getOperation(organizationId: string, id: string): Promise<Operation | undefined> {
    return this.operations.get(organizationId, id);
  }

  async deleteSubjectJobs(organizationId: string, subjectId: string): Promise<number> {
    let removed = 0;
    for (const name of JOB_QUEUES)
      removed += await this.queue(name, organizationId).deleteBySubject(subjectId);
    return removed;
  }

  queue(
    name: JobQueueName,
    organizationId = 'default',
  ): InMemoryJobQueue<unknown> | DistributedJobQueue<unknown> {
    const key = `${organizationId}:${name}`;
    let queue = this.queues.get(key);
    if (queue === undefined) {
      const database = this.database;
      queue =
        database === undefined
          ? new InMemoryJobQueue(name)
          : this.createDistributedQueue(name, organizationId, database);
      this.queues.set(key, queue);
    }
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.bullQueues].map((queue) => queue.close()));
  }

  private createDistributedQueue(
    name: JobQueueName,
    organizationId: string,
    database: DatabaseService,
  ): DistributedJobQueue<unknown> {
    const config = database.config;
    const options = operationQueueOptions(name, config);
    if (config.deployment.profile !== 'distributed' || config.queue.redisUrl === undefined) {
      return new DistributedJobQueue(
        name,
        new RepositoryJobTransport(
          (repositoryName) => database.adapter.repository(repositoryName),
          organizationId,
        ),
        options,
      );
    }
    const redisUrl = config.queue.redisUrl;
    const transport = new BullMqJobTransport<unknown>(
      (queueName) => {
        const queue = new Queue(queueName, {
          connection: redisConnection(redisUrl, config.queue.topology, config.queue.natMap),
        });
        this.bullQueues.add(queue);
        return {
          add: async (
            jobName: string,
            data: unknown,
            options: { jobId: string; delay?: number; priority?: number },
          ) => {
            await queue.add(jobName, data, options);
          },
          getJobs: (
            types: readonly ('waiting' | 'delayed' | 'prioritized')[],
            start: number,
            end: number,
            asc: boolean,
          ) => queue.getJobs([...types], start, end, asc),
          getJobCounts: (...types: readonly ('waiting' | 'delayed' | 'prioritized')[]) =>
            queue.getJobCounts(...types),
          remove: async (jobId: string) => {
            await queue.remove(jobId);
          },
        } as unknown as BullMqQueue<unknown>;
      },
      organizationId,
      config.queue.namespaces.queues,
    );
    return new DistributedJobQueue(name, transport, options);
  }
}

export function operationQueueOptions(
  name: JobQueueName,
  config: Pick<DatabaseService, 'config'>['config'],
): JobOptions {
  const timeoutMs: Record<JobQueueName, number> = {
    agents: config.timeouts.agent,
    embeddings: config.timeouts.provider,
    documents: config.timeouts.http,
    plugins: config.timeouts.tool,
    webhooks: config.timeouts.http,
    audit: config.timeouts.workflow,
    billing: config.timeouts.workflow,
    cleanup: config.timeouts.workflow,
    indexing: config.timeouts.workflow,
    'workflow-executions': config.timeouts.workflow,
  };
  return {
    timeoutMs: timeoutMs[name],
    retentionMs: config.retention.audit * 86_400_000,
  };
}

function redisConnection(
  redisUrl: string,
  topology: 'standalone' | 'sentinel' | 'cluster',
  natMap: Record<string, { host: string; port: number }> = {},
): ConnectionOptions {
  const url = new URL(redisUrl.replace(/^redis\+(?:sentinel|cluster):\/\//u, 'redis://'));
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:')
    throw new ValidationError('Redis URL is invalid');
  const password = url.password === '' ? undefined : decodeURIComponent(url.password);
  const username = url.username === '' ? undefined : decodeURIComponent(url.username);
  const port = url.port === '' ? 6379 : Number(url.port);
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined;
  const redisOptions: RedisOptions = {
    host: url.hostname,
    port,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    ...(db === undefined ? {} : { db }),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
  if (topology === 'standalone') return redisOptions;
  if (topology === 'sentinel')
    return {
      ...redisOptions,
      sentinels: [{ host: url.hostname, port }],
      name: url.searchParams.get('master') ?? 'mymaster',
      ...(Object.keys(natMap).length === 0 ? {} : { natMap }),
    };
  return new Cluster([{ host: url.hostname, port }], {
    redisOptions: {
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      ...(db === undefined ? {} : { db }),
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    },
  });
}

const GLOBAL_TENANT = '__global__';

interface FeatureFlagEntity extends TenantEntity {
  readonly key: string;
  readonly scope: FeatureFlagScope;
  readonly enabled: boolean;
  readonly organizationId?: string;
  readonly userId?: string;
}

function featureFlagId(
  flag: Pick<FeatureFlag, 'key' | 'scope' | 'organizationId' | 'userId'>,
): string {
  return encodeURIComponent(
    [flag.key, flag.scope, flag.organizationId ?? '', flag.userId ?? ''].join('|'),
  );
}

function entityToFeatureFlag(entity: FeatureFlagEntity): FeatureFlag {
  return {
    key: entity.key,
    scope: entity.scope,
    enabled: entity.enabled,
    ...(entity.organizationId === undefined ? {} : { organizationId: entity.organizationId }),
    ...(entity.userId === undefined ? {} : { userId: entity.userId }),
    updatedAt: entity.updatedAt,
  };
}
