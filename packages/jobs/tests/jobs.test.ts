import { describe, expect, it } from 'vitest';
import {
  BackpressureError,
  BullMqJobTransport,
  DistributedJobQueue,
  InMemoryOperationStore,
  RepositoryOperationStore,
  InMemoryJobQueue,
  JobWorker,
  RepositoryJobTransport,
  type Job,
  type DurableJobTransport,
  type JobTransportUnavailableError,
  type Operation,
} from '../src/index.js';
import type {
  Page,
  PageRequest,
  Repository,
  RepositoryName,
  TenantEntity,
} from '@handstack/domain';

describe('job queues', () => {
  it('emits queue observations without exposing job payloads', async () => {
    const observations: { operation: string; outcome: string; durationMs: number }[] = [];
    const queue = new InMemoryJobQueue('agents');
    const transport: DurableJobTransport<unknown> = {
      enqueue: (_name, job) => {
        queue.enqueue({ id: job.id, payload: job.payload, idempotencyKey: job.idempotencyKey });
        return Promise.resolve();
      },
      dequeue: () => Promise.resolve(undefined),
      requeue: () => Promise.resolve(undefined),
      deadLetter: () => Promise.resolve(undefined),
      backlog: () => Promise.resolve(0),
    };
    const distributed = new DistributedJobQueue('agents', transport, {}, (observation) => {
      observations.push(observation);
    });
    await distributed.enqueue({
      id: 'observed',
      payload: { secret: 'redacted' },
      idempotencyKey: 'observed',
    });
    expect(observations).toMatchObject([{ operation: 'enqueue', outcome: 'success' }]);
    expect(observations[0]).not.toHaveProperty('payload');
    expect(Number.isFinite(observations[0]?.durationMs)).toBe(true);
  });

  it('enforces idempotency, backpressure, retries and DLQ', async () => {
    const queue = new InMemoryJobQueue('agents', {
      maxBacklog: 1,
      maxAttempts: 2,
      retryBaseMs: 0,
      retryJitterMs: 0,
    });
    const first = queue.enqueue({ id: '1', payload: { value: 1 }, idempotencyKey: 'same' });
    expect(queue.enqueue({ id: 'ignored', payload: { value: 2 }, idempotencyKey: 'same' })).toBe(
      first,
    );
    expect(() =>
      queue.enqueue({ id: '2', payload: { value: 2 }, idempotencyKey: 'other' }),
    ).toThrow(BackpressureError);
    await expect(
      queue.process(() => {
        throw new Error('no');
      }),
    ).resolves.toMatchObject({ status: 'RETRY_SCHEDULED' });
    await expect(
      queue.process(() => {
        throw new Error('no');
      }),
    ).resolves.toMatchObject({ status: 'DEAD_LETTERED' });
    expect(queue.deadLetters).toHaveLength(1);
  });
  it('lists, retries and discards dead letters with bounded tenant queue state', async () => {
    const queue = new InMemoryJobQueue('agents', {
      maxAttempts: 1,
      retryBaseMs: 0,
      retryJitterMs: 0,
    });
    queue.enqueue({ id: 'dead-1', payload: { value: 1 }, idempotencyKey: 'dead-1' });
    await expect(queue.process(() => Promise.reject(new Error('poison')))).resolves.toMatchObject({
      status: 'DEAD_LETTERED',
    });
    expect(queue.listDeadLetters()).toMatchObject([
      { job: { id: 'dead-1', attempts: 1 }, error: 'poison' },
    ]);
    expect(queue.retryDeadLetter('dead-1')).toMatchObject({ id: 'dead-1', attempts: 0 });
    expect(queue.listDeadLetters()).toHaveLength(0);
    await expect(
      queue.process(() => Promise.reject(new Error('poison again'))),
    ).resolves.toMatchObject({
      status: 'DEAD_LETTERED',
    });
    expect(queue.discardDeadLetter('dead-1')).toBe(true);
    expect(queue.discardDeadLetter('dead-1')).toBe(false);
  });
  it('cancels before consuming a job and reports timeout', async () => {
    const queue = new InMemoryJobQueue('cleanup', { timeoutMs: 5 });
    const controller = new AbortController();
    queue.enqueue({ id: '1', payload: {}, idempotencyKey: '1' });
    controller.abort();
    await expect(queue.process(() => Promise.resolve(), controller.signal)).resolves.toMatchObject({
      status: 'CANCELLED',
    });
  });

  it('delegates durable enqueue/retry/dead-letter semantics to a BullMQ-compatible transport', async () => {
    const pending: Job<{ value: number }>[] = [];
    const dead: Job<{ value: number }>[] = [];
    const transport: DurableJobTransport<{ value: number }> = {
      enqueue: (_queue, job) =>
        Promise.resolve().then(() => {
          pending.push(job);
        }),
      dequeue: () => Promise.resolve().then(() => pending.shift()),
      requeue: (_queue, job) =>
        Promise.resolve().then(() => {
          pending.push(job);
        }),
      deadLetter: (_queue, job) =>
        Promise.resolve().then(() => {
          dead.push(job);
        }),
      backlog: async () => Promise.resolve(pending.length),
    };
    const queue = new DistributedJobQueue('agents', transport, { maxBacklog: 1, maxAttempts: 1 });
    await queue.enqueue({ id: 'durable-1', payload: { value: 1 }, idempotencyKey: 'durable-1' });
    await expect(
      queue.enqueue({ id: 'durable-2', payload: { value: 2 }, idempotencyKey: 'durable-2' }),
    ).rejects.toBeInstanceOf(BackpressureError);
    await expect(queue.process(() => Promise.reject(new Error('failure')))).resolves.toMatchObject({
      status: 'DEAD_LETTERED',
    });
    expect(dead).toHaveLength(1);
  });
  it('normalizes every distributed transport failure with retry guidance and cause', async () => {
    let failure: string | undefined;
    const job: Job<unknown> = {
      id: 'transport-job',
      queue: 'agents',
      payload: {},
      idempotencyKey: 'transport-job',
      priority: 0,
      attempts: 0,
      availableAt: Date.now(),
      createdAt: new Date(),
    };
    const transport: DurableJobTransport<unknown> = {
      enqueue: () =>
        failure === 'enqueue' ? Promise.reject(new Error('redis enqueue down')) : Promise.resolve(),
      dequeue: () =>
        failure === 'dequeue'
          ? Promise.reject(new Error('redis dequeue down'))
          : Promise.resolve(job),
      requeue: () =>
        failure === 'requeue' ? Promise.reject(new Error('redis requeue down')) : Promise.resolve(),
      deadLetter: () =>
        failure === 'dead-letter' ? Promise.reject(new Error('redis dlq down')) : Promise.resolve(),
      backlog: () =>
        failure === 'backlog'
          ? Promise.reject(new Error('redis backlog down'))
          : Promise.resolve(0),
    };
    const queue = new DistributedJobQueue('agents', transport, {
      maxAttempts: 1,
      retryAfterSeconds: 9,
      retryBaseMs: 0,
      retryJitterMs: 0,
    });
    const expectTransportFailure = async (operation: JobTransportUnavailableError['operation']) => {
      const result = queue.backlog;
      await expect(result).rejects.toMatchObject({
        code: 'JOB_TRANSPORT_UNAVAILABLE',
        operation,
        retryAfterSeconds: 9,
      });
    };

    failure = 'backlog';
    await expectTransportFailure('backlog');
    failure = 'enqueue';
    await expect(
      queue.enqueue({ id: 'enqueue', payload: {}, idempotencyKey: 'enqueue' }),
    ).rejects.toMatchObject({
      operation: 'enqueue',
      cause: new Error('redis enqueue down'),
    });
    failure = 'dequeue';
    await expect(queue.process(() => Promise.resolve())).rejects.toMatchObject({
      operation: 'dequeue',
    });
    failure = 'requeue';
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(queue.process(() => Promise.resolve(), cancelled.signal)).rejects.toMatchObject({
      operation: 'requeue',
    });
    failure = 'dead-letter';
    await expect(
      queue.process(() => Promise.reject(new Error('handler failed'))),
    ).rejects.toMatchObject({
      operation: 'dead-letter',
      cause: new Error('redis dlq down'),
    });
  });

  it('observes execution duration and transport failures for terminal jobs', async () => {
    const observations: { operation: string; outcome: string; durationMs: number }[] = [];
    const job: Job<unknown> = {
      id: 'observed-failure',
      queue: 'agents',
      payload: {},
      idempotencyKey: 'observed-failure',
      priority: 0,
      attempts: 0,
      availableAt: Date.now(),
      createdAt: new Date(),
    };
    const transport: DurableJobTransport<unknown> = {
      enqueue: () => Promise.resolve(undefined),
      dequeue: () => Promise.resolve(job),
      requeue: () => Promise.resolve(undefined),
      deadLetter: () => Promise.reject(new Error('dlq unavailable')),
      backlog: () => Promise.resolve(0),
    };
    const queue = new DistributedJobQueue(
      'agents',
      transport,
      { maxAttempts: 1 },
      (observation) => {
        observations.push(observation);
      },
    );
    await expect(
      queue.process(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error('handler failed');
      }),
    ).rejects.toMatchObject({ code: 'JOB_TRANSPORT_UNAVAILABLE', operation: 'dead-letter' });
    expect(observations).toMatchObject([
      { operation: 'dequeue', outcome: 'success' },
      { operation: 'dead-letter', outcome: 'error' },
    ]);
    expect(observations.every(({ durationMs }) => Number.isFinite(durationMs))).toBe(true);
  });
  it('maps tenant-scoped jobs to BullMQ queues and preserves idempotency metadata', async () => {
    const queues = new Map<string, FakeBullQueue>();
    const factory = (name: string) => {
      const existing = queues.get(name);
      if (existing !== undefined) return existing;
      const created = new FakeBullQueue();
      queues.set(name, created);
      return created;
    };
    const transport = new BullMqJobTransport<{ value: number }>(factory, 'org-a', 'hs-test');
    const createdAt = new Date();
    const job: Job<{ value: number }> = {
      id: 'job-1',
      queue: 'agents',
      payload: { value: 7 },
      idempotencyKey: 'idem-1',
      priority: 4,
      attempts: 2,
      availableAt: Date.now(),
      createdAt,
    };
    await transport.enqueue('agents', job);
    await transport.enqueue('agents', { ...job, id: 'job-2' });
    expect(await transport.backlog('agents')).toBe(1);
    await expect(transport.dequeue('agents')).resolves.toMatchObject({
      id: 'job-1',
      payload: { value: 7 },
      idempotencyKey: 'idem-1',
      attempts: 2,
      priority: 4,
    });
    await transport.deadLetter('agents', job, new Error('poison'));
    expect([...queues.keys()]).toEqual([
      'hs-test:org-a:agents',
      'hs-test:org-a:agents:dead-letter',
    ]);
  });

  it('administers BullMQ dead letters with tenant isolation and retry reset', async () => {
    const queues = new Map<string, FakeBullQueue>();
    const factory = (name: string) => {
      const existing = queues.get(name);
      if (existing !== undefined) return existing;
      const created = new FakeBullQueue();
      queues.set(name, created);
      return created;
    };
    const transport = new BullMqJobTransport<{ value: number }>(factory, 'org-a', 'hs-test');
    const job: Job<{ value: number }> = {
      id: 'dead-bullmq',
      queue: 'agents',
      payload: { value: 3 },
      idempotencyKey: 'dead-bullmq',
      priority: 0,
      attempts: 4,
      availableAt: Date.now(),
      createdAt: new Date(),
    };
    await transport.deadLetter('agents', job, new Error('provider failed'));
    await expect(transport.listDeadLetters('agents')).resolves.toMatchObject([
      { job: { idempotencyKey: 'dead-bullmq', attempts: 4 }, error: 'provider failed' },
    ]);
    await expect(transport.retryDeadLetter('agents', 'dead-bullmq')).resolves.toMatchObject({
      idempotencyKey: 'dead-bullmq',
      attempts: 0,
    });
    await expect(transport.listDeadLetters('agents')).resolves.toHaveLength(0);
    expect(await transport.dequeue('agents')).toMatchObject({
      idempotencyKey: 'dead-bullmq',
      attempts: 0,
    });
    await transport.deadLetter('agents', job, 'discard me');
    await expect(transport.discardDeadLetter('agents', 'dead-bullmq')).resolves.toBe(true);
    await expect(transport.discardDeadLetter('agents', 'dead-bullmq')).resolves.toBe(false);
  });
  it('rejects malformed distributed job scheduling inputs', async () => {
    const transport: DurableJobTransport<unknown> = {
      enqueue: () => Promise.resolve(),
      dequeue: () => Promise.resolve(undefined),
      requeue: () => Promise.resolve(),
      deadLetter: () => Promise.resolve(),
      backlog: () => Promise.resolve(0),
    };
    const queue = new DistributedJobQueue('agents', transport);
    await expect(queue.enqueue({ id: ' ', payload: {}, idempotencyKey: 'id' })).rejects.toThrow(
      'Job id',
    );
    await expect(
      queue.enqueue({ id: 'id', payload: {}, idempotencyKey: 'id', priority: Number.NaN }),
    ).rejects.toThrow('priority');
    await expect(
      queue.enqueue({ id: 'id', payload: {}, idempotencyKey: 'id', delayMs: -1 }),
    ).rejects.toThrow('delay');
    expect(() => new DistributedJobQueue('agents', transport, { timeoutMs: 0 })).toThrow('timeout');
    expect(() => new DistributedJobQueue('agents', transport, { retryJitterMs: -1 })).toThrow(
      'jitter',
    );
    const memory = new InMemoryJobQueue('agents');
    expect(() => memory.enqueue({ id: ' ', payload: {}, idempotencyKey: 'memory' })).toThrow(
      'Job id',
    );
    expect(() =>
      memory.enqueue({ id: 'memory', payload: {}, idempotencyKey: 'memory', delayMs: -1 }),
    ).toThrow('delay');
  });

  it('reclaims expired repository leases after a worker restart', async () => {
    const repository = new JobRepository();
    const factory = (() => repository) as <E extends TenantEntity>(
      name: RepositoryName,
    ) => Repository<E>;
    const first = new RepositoryJobTransport(factory, 'org-a', 1);
    const job = {
      id: 'durable',
      queue: 'agents' as const,
      payload: { value: 1 },
      idempotencyKey: 'k',
      priority: 0,
      attempts: 0,
      availableAt: Date.now(),
      createdAt: new Date(),
    };
    await first.enqueue('agents', job);
    expect(await first.dequeue('agents')).toMatchObject({ id: 'durable' });
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(await new RepositoryJobTransport(factory, 'org-a', 1).dequeue('agents')).toMatchObject({
      id: 'durable',
    });
  });

  it('runs with bounded concurrency, emits heartbeats and requeues on graceful stop', async () => {
    const pending: Job<{ value: number }>[] = [];
    const transport: DurableJobTransport<{ value: number }> = {
      enqueue: (_queue, job) => {
        pending.push(job);
        return Promise.resolve();
      },
      dequeue: () => Promise.resolve(pending.shift()),
      requeue: (_queue, job) => {
        pending.push(job);
        return Promise.resolve();
      },
      deadLetter: () => Promise.resolve(),
      backlog: () => Promise.resolve(pending.length),
    };
    const queue = new DistributedJobQueue('agents', transport, { timeoutMs: 1000 });
    await queue.enqueue({ id: 'one', payload: { value: 1 }, idempotencyKey: 'one' });
    await queue.enqueue({ id: 'two', payload: { value: 2 }, idempotencyKey: 'two' });
    let active = 0;
    let maximum = 0;
    let started = 0;
    const heartbeats: string[] = [];
    const worker = new JobWorker(
      queue,
      async (_payload, context) => {
        active += 1;
        maximum = Math.max(maximum, active);
        started += 1;
        context.heartbeat();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            'abort',
            () => {
              active -= 1;
              resolve();
            },
            { once: true },
          );
        });
      },
      { concurrency: 2, pollIntervalMs: 1, onHeartbeat: (job) => heartbeats.push(job.id) },
    );
    const running = worker.start();
    while (started < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(maximum).toBe(2);
    expect(heartbeats.sort()).toEqual(['one', 'two']);
    await worker.stop();
    await running;
    expect(active).toBe(0);
    expect(pending).toHaveLength(2);
  });
});

describe('asynchronous operations', () => {
  it('creates pending tenant-scoped resources and isolates reads by organization', async () => {
    const store = new InMemoryOperationStore();
    const operation = await store.create({
      organizationId: 'org-a',
      type: 'knowledge.reindex',
      idempotencyKey: 'reindex-1',
    });

    expect(operation).toMatchObject({
      organizationId: 'org-a',
      tenantId: 'org-a',
      type: 'knowledge.reindex',
      idempotencyKey: 'reindex-1',
      status: 'PENDING',
      cancelRequested: false,
      version: 1,
    });
    await expect(store.get('org-a', operation.id)).resolves.toEqual(operation);
    await expect(store.get('org-b', operation.id)).resolves.toBeUndefined();
    await expect(
      store.create({
        organizationId: 'org-a',
        type: 'knowledge.reindex',
        idempotencyKey: 'reindex-1',
      }),
    ).resolves.toEqual(operation);
    await expect(
      store.create({
        organizationId: 'org-a',
        type: 'export',
        idempotencyKey: 'reindex-1',
      }),
    ).rejects.toThrow('Operation idempotency conflict');
  });

  it('updates with optimistic concurrency and preserves cancellation state', async () => {
    const store = new InMemoryOperationStore();
    const operation = await store.create({
      organizationId: 'org-a',
      type: 'export',
      idempotencyKey: 'export-1',
    });
    const cancelled = await store.update(
      { ...operation, status: 'CANCELLED', cancelRequested: true },
      operation.version,
    );

    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelRequested: true, version: 2 });
    await expect(store.update(operation, operation.version)).rejects.toThrow('Operation conflict');
  });

  it('rejects operations without an idempotency key', async () => {
    const store = new InMemoryOperationStore();
    await expect(
      store.create({ organizationId: 'org-a', type: 'export', idempotencyKey: ' ' }),
    ).rejects.toThrow('Idempotency key is required');
    await expect(store.findByIdempotencyKey('org-a', ' ')).rejects.toThrow(
      'Idempotency key is required',
    );
  });

  it('keeps whitespace outside the idempotency key from changing its identity', async () => {
    const store = new InMemoryOperationStore();
    const first = await store.create({
      organizationId: 'org-a',
      type: 'export',
      idempotencyKey: 'export-2',
    });
    const replay = await store.create({
      organizationId: 'org-a',
      type: 'export',
      idempotencyKey: ' export-2 ',
    });
    expect(replay).toEqual(first);
  });

  it('rejects invalid lifecycle jumps', async () => {
    const store = new InMemoryOperationStore();
    const operation = await store.create({
      organizationId: 'org-a',
      type: 'export',
      idempotencyKey: 'export-3',
    });
    await expect(
      store.update({ ...operation, status: 'SUCCEEDED' }, operation.version),
    ).rejects.toThrow('Invalid operation transition');
  });

  it('keeps repository-backed operation creation idempotent for direct store callers', async () => {
    const repository = new OperationRepository();
    const factory = (() => repository) as <E extends TenantEntity>(
      name: RepositoryName,
    ) => Repository<E>;
    const store = new RepositoryOperationStore(factory);
    const first = await store.create({
      organizationId: 'org-a',
      type: 'export',
      idempotencyKey: 'export-repository-1',
    });
    const replay = await store.create({
      organizationId: 'org-a',
      type: 'export',
      idempotencyKey: ' export-repository-1 ',
    });
    expect(replay).toEqual(first);
    await expect(
      store.create({
        organizationId: 'org-a',
        type: 'import',
        idempotencyKey: 'export-repository-1',
      }),
    ).rejects.toThrow('Operation idempotency conflict');
  });

  it('serializes concurrent repository-backed creates for one idempotency key', async () => {
    const repository = new OperationRepository();
    const factory = (() => repository) as <E extends TenantEntity>(
      name: RepositoryName,
    ) => Repository<E>;
    const store = new RepositoryOperationStore(factory);
    const operations = await Promise.all(
      Array.from({ length: 3 }, () =>
        store.create({
          organizationId: 'org-a',
          type: 'export',
          idempotencyKey: 'export-concurrent',
        }),
      ),
    );
    expect(new Set(operations.map((operation) => operation.id)).size).toBe(1);
  });

  it('rejects operation identity changes and out-of-range progress', async () => {
    const store = new InMemoryOperationStore();
    const operation = await store.create({
      organizationId: 'org-a',
      type: 'export',
      idempotencyKey: 'export-immutable',
    });
    await expect(store.update({ ...operation, type: 'import' }, operation.version)).rejects.toThrow(
      'Operation identity is immutable',
    );
    await expect(store.update({ ...operation, progress: 101 }, operation.version)).rejects.toThrow(
      'Operation progress must be between 0 and 100',
    );
  });
});

class OperationRepository implements Repository<Operation> {
  private readonly values = new Map<string, Operation>();

  findById(tenantId: string, id: string) {
    return Promise.resolve(this.values.get(`${tenantId}:${id}`));
  }

  list(tenantId: string, page: PageRequest): Promise<Page<Operation>> {
    const values = [...this.values.values()].filter((item) => item.tenantId === tenantId);
    const start =
      page.cursor === undefined ? 0 : values.findIndex((item) => item.id === page.cursor) + 1;
    const items = values.slice(start, start + page.limit);
    const last = items.at(-1);
    return Promise.resolve({
      items,
      ...(start + page.limit < values.length && last !== undefined ? { nextCursor: last.id } : {}),
    });
  }

  insert(entity: Operation) {
    this.values.set(`${entity.tenantId}:${entity.id}`, entity);
    return Promise.resolve(entity);
  }

  update(entity: Operation, expectedVersion: number) {
    const current = this.values.get(`${entity.tenantId}:${entity.id}`);
    if (current?.version !== expectedVersion) return Promise.reject(new Error('conflict'));
    this.values.set(`${entity.tenantId}:${entity.id}`, entity);
    return Promise.resolve(entity);
  }

  delete(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

class FakeBullQueue {
  private readonly jobs = new Map<
    string,
    { id: string; data: unknown; opts: { delay?: number; priority?: number }; timestamp: number }
  >();
  add(_name: string, data: unknown, options: { jobId: string; delay?: number; priority?: number }) {
    if (!this.jobs.has(options.jobId))
      this.jobs.set(options.jobId, {
        id: options.jobId,
        data,
        opts: options,
        timestamp: Date.now(),
      });
    return Promise.resolve();
  }
  getJobs(_types: readonly ('waiting' | 'delayed' | 'prioritized')[], start: number, end: number) {
    const values = [...this.jobs.values()];
    return Promise.resolve(values.slice(start, end < 0 ? undefined : end + 1));
  }
  getJobCounts() {
    return Promise.resolve({ waiting: this.jobs.size });
  }
  remove(jobId: string) {
    this.jobs.delete(jobId);
    return Promise.resolve();
  }
}

class JobRepository implements Repository<
  TenantEntity & {
    queueName: string;
    state: string;
    job: Job<unknown>;
    leaseUntil?: number;
    error?: string;
  }
> {
  private readonly values = new Map<
    string,
    TenantEntity & {
      queueName: string;
      state: string;
      job: Job<unknown>;
      leaseUntil?: number;
      error?: string;
    }
  >();
  findById(tenantId: string, id: string) {
    return Promise.resolve(this.values.get(`${tenantId}:${id}`));
  }
  list(
    tenantId: string,
    page: PageRequest,
  ): Promise<
    Page<
      TenantEntity & {
        queueName: string;
        state: string;
        job: Job<unknown>;
        leaseUntil?: number;
        error?: string;
      }
    >
  > {
    const values = [...this.values.values()]
      .filter((item) => item.tenantId === tenantId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const start =
      page.cursor === undefined ? 0 : values.findIndex((item) => item.id === page.cursor) + 1;
    const items = values.slice(start, start + page.limit);
    const last = items.at(-1);
    return Promise.resolve({
      items,
      ...(start + page.limit < values.length && last !== undefined ? { nextCursor: last.id } : {}),
    });
  }
  insert(
    entity: TenantEntity & {
      queueName: string;
      state: string;
      job: Job<unknown>;
      leaseUntil?: number;
      error?: string;
    },
  ) {
    this.values.set(`${entity.tenantId}:${entity.id}`, entity);
    return Promise.resolve(entity);
  }
  update(
    entity: TenantEntity & {
      queueName: string;
      state: string;
      job: Job<unknown>;
      leaseUntil?: number;
      error?: string;
    },
    expectedVersion: number,
  ) {
    const current = this.values.get(`${entity.tenantId}:${entity.id}`);
    if (current?.version !== expectedVersion) return Promise.reject(new Error('conflict'));
    this.values.set(`${entity.tenantId}:${entity.id}`, entity);
    return Promise.resolve(entity);
  }
  delete(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
