import { ValidationError } from '@handstack/shared';
import {
  repositoryName,
  uuidV7,
  type Repository,
  type RepositoryName,
  type TenantEntity,
} from '@handstack/domain';

export const JOB_QUEUES = [
  'agents',
  'embeddings',
  'documents',
  'plugins',
  'webhooks',
  'audit',
  'billing',
  'cleanup',
  'indexing',
  'workflow-executions',
] as const;
export type JobQueueName = (typeof JOB_QUEUES)[number];

/** BullMQ rejects `:` in queue names; encode each namespace segment deterministically. */
export function bullMqQueueName(namespace: string, organizationId: string, queue: string): string {
  return [namespace, organizationId, queue].map((part) => part.replaceAll(':', '_')).join('__');
}

export class BackpressureError extends Error {
  readonly code = 'JOB_BACKPRESSURE';
  constructor(readonly retryAfterSeconds: number) {
    super(`Job queue is at capacity; retry after ${String(retryAfterSeconds)} seconds`);
    this.name = 'BackpressureError';
  }
}

export class JobTransportUnavailableError extends Error {
  readonly code = 'JOB_TRANSPORT_UNAVAILABLE';

  constructor(
    readonly operation: 'backlog' | 'enqueue' | 'dequeue' | 'requeue' | 'dead-letter',
    readonly retryAfterSeconds: number,
    override readonly cause: unknown,
  ) {
    super(
      `Job transport unavailable during ${operation}; retry after ${String(retryAfterSeconds)} seconds`,
    );
    this.name = 'JobTransportUnavailableError';
  }
}

export interface Job<T> {
  readonly id: string;
  readonly queue: JobQueueName;
  readonly payload: T;
  readonly idempotencyKey: string;
  readonly priority: number;
  readonly attempts: number;
  readonly availableAt: number;
  readonly createdAt: Date;
  readonly context?: JobExecutionContext;
}
export interface JobExecutionContext {
  readonly requestId: string;
  readonly traceId: string;
  readonly principalId: string;
  readonly source: string;
}
export interface JobCheckpoint {
  readonly attempt: number;
  readonly value?: unknown;
}
export interface JobContext {
  readonly signal: AbortSignal;
  heartbeat(): void;
  checkpoint(value?: unknown): Promise<void>;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly principalId?: string;
  readonly source?: string;
}
export interface DeadLetterJob<T> {
  readonly job: Job<T>;
  readonly error: string;
  readonly deadLetteredAt: Date;
}
export interface JobProcessOptions {
  readonly onJob?: (job: Job<unknown>) => void;
  readonly onHeartbeat?: (timestamp: number) => void;
}
export interface JobObservation {
  readonly operation: 'enqueue' | 'dequeue' | 'completed' | 'retry' | 'requeue' | 'dead-letter';
  readonly queue: JobQueueName;
  readonly outcome: 'success' | 'error';
  readonly durationMs: number;
}
export type JobObservationSink = (observation: JobObservation) => void;
export interface JobOptions {
  readonly maxBacklog?: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly retryBaseMs?: number;
  readonly retryJitterMs?: number;
  readonly retentionMs?: number;
  readonly retryAfterSeconds?: number;
}

/**
 * Minimal durable queue transport contract.  The package deliberately does not
 * depend on `bullmq` or a Redis client: applications wire those clients through
 * this contract, which keeps the domain package portable and testable offline.
 * A BullMQ adapter must make enqueue/dequeue/requeue/dead-letter operations
 * durable and idempotent (at-least-once delivery is expected).
 */
export interface DurableJobTransport<T> {
  enqueue(queue: JobQueueName, job: Job<T>): Promise<void>;
  dequeue(queue: JobQueueName): Promise<Job<T> | undefined>;
  requeue(queue: JobQueueName, job: Job<T>, delayMs: number): Promise<void>;
  deadLetter(queue: JobQueueName, job: Job<T>, error: unknown): Promise<void>;
  backlog(queue: JobQueueName): Promise<number>;
  /** Removes pending and dead-lettered payloads belonging to a data subject. */
  deleteBySubject?(queue: JobQueueName, subjectId: string): Promise<number>;
}

/** Optional administrative operations for inspecting and operating a DLQ. */
export interface JobDeadLetterAdmin<T> {
  listDeadLetters(queue: JobQueueName): Promise<readonly DeadLetterJob<T>[]>;
  retryDeadLetter(queue: JobQueueName, idempotencyKey: string): Promise<Job<T> | undefined>;
  discardDeadLetter(queue: JobQueueName, idempotencyKey: string): Promise<boolean>;
}

/** The small subset of BullMQ's Queue API required by this adapter. */
export interface BullMqQueue<T> {
  add(
    name: string,
    data: T,
    options: { jobId: string; delay?: number; priority?: number },
  ): Promise<void>;
  getJobs(
    types: readonly ('waiting' | 'delayed' | 'prioritized')[],
    start: number,
    end: number,
    asc: boolean,
  ): Promise<readonly BullMqStoredJob<T>[]>;
  getJobCounts(
    ...types: readonly ('waiting' | 'delayed' | 'prioritized')[]
  ): Promise<Record<string, number>>;
  remove(jobId: string): Promise<void>;
}

export interface BullMqStoredJob<T> {
  readonly id: string;
  readonly data: T;
  readonly opts: { readonly delay?: number; readonly priority?: number };
  readonly timestamp: number;
  readonly attemptsMade?: number;
}

interface BullMqEnvelope<T> {
  readonly id: string;
  readonly payload: T;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly createdAt: number;
  readonly context?: JobExecutionContext;
}

interface BullMqDeadLetterEnvelope<T> {
  readonly job: Job<T>;
  readonly error: string;
}

/**
 * BullMQ transport adapter.  BullMQ remains an optional infrastructure
 * dependency: callers provide Queue instances, while this package owns the
 * tenant namespace, idempotency and portable job mapping.
 */
export class BullMqJobTransport<T> implements DurableJobTransport<T>, JobDeadLetterAdmin<T> {
  private readonly queues = new Map<JobQueueName, BullMqQueue<unknown>>();
  private readonly namespace: string;

  constructor(
    queueFactory: (queueName: string) => BullMqQueue<unknown>,
    private readonly organizationId: string,
    namespace = 'handstack',
  ) {
    if (organizationId.trim() === '') throw new ValidationError('Job organization is required');
    if (namespace.trim() === '') throw new ValidationError('Job namespace is required');
    this.namespace = namespace;
    this.queueFactory = queueFactory;
  }

  private readonly queueFactory: (queueName: string) => BullMqQueue<unknown>;

  enqueue(queue: JobQueueName, job: Job<T>): Promise<void> {
    return this.queue(queue).add(
      'job',
      {
        payload: job.payload,
        id: job.id,
        idempotencyKey: job.idempotencyKey,
        attempts: job.attempts,
        createdAt: job.createdAt.getTime(),
        ...(job.context === undefined ? {} : { context: job.context }),
      },
      {
        jobId: this.jobId(job),
        ...(job.availableAt > Date.now() ? { delay: job.availableAt - Date.now() } : {}),
        ...(job.priority === 0 ? {} : { priority: job.priority }),
      },
    );
  }

  async dequeue(queue: JobQueueName): Promise<Job<T> | undefined> {
    const stored = (
      await this.queue(queue).getJobs(['waiting', 'delayed', 'prioritized'], 0, 0, true)
    )[0] as BullMqStoredJob<BullMqEnvelope<T>> | undefined;
    if (stored === undefined || stored.timestamp > Date.now()) return undefined;
    await this.queue(queue).remove(stored.id);
    return {
      id: stored.data.id,
      queue,
      payload: stored.data.payload,
      idempotencyKey: stored.data.idempotencyKey,
      priority: stored.opts.priority ?? 0,
      attempts: stored.data.attempts,
      availableAt: stored.timestamp + (stored.opts.delay ?? 0),
      createdAt: new Date(stored.data.createdAt),
      ...(stored.data.context === undefined ? {} : { context: stored.data.context }),
    };
  }

  requeue(queue: JobQueueName, job: Job<T>, delayMs: number): Promise<void> {
    return this.enqueue(queue, { ...job, availableAt: Date.now() + delayMs });
  }

  async deadLetter(queue: JobQueueName, job: Job<T>, error: unknown): Promise<void> {
    await this.deadLetterQueue(queue).add(
      'job',
      { job, error: error instanceof Error ? error.message : String(error) },
      {
        jobId: this.jobId(job),
      },
    );
  }

  async backlog(queue: JobQueueName): Promise<number> {
    const counts = await this.queue(queue).getJobCounts('waiting', 'delayed', 'prioritized');
    return Object.values(counts).reduce((total, count) => total + count, 0);
  }

  async deleteBySubject(queue: JobQueueName, subjectId: string): Promise<number> {
    if (subjectId.trim() === '') throw new ValidationError('Job subject is required');
    let removed = 0;
    for (const target of [this.queue(queue), this.deadLetterQueue(queue)]) {
      const jobs = await target.getJobs(['waiting', 'delayed', 'prioritized'], 0, -1, true);
      for (const stored of jobs) {
        const data = stored.data as BullMqEnvelope<T> | BullMqDeadLetterEnvelope<T>;
        const payload = 'payload' in data ? data.payload : data.job.payload;
        if (containsSubject(payload, subjectId)) {
          await target.remove(stored.id);
          removed += 1;
        }
      }
    }
    return removed;
  }

  async listDeadLetters(queue: JobQueueName): Promise<readonly DeadLetterJob<T>[]> {
    const stored = await this.deadLetterQueue(queue).getJobs(
      ['waiting', 'delayed', 'prioritized'],
      0,
      -1,
      true,
    );
    return stored.flatMap((candidate) => {
      const data = candidate.data as BullMqDeadLetterEnvelope<T>;
      return [
        {
          job: data.job,
          error: data.error,
          deadLetteredAt: new Date(candidate.timestamp),
        },
      ];
    });
  }

  async retryDeadLetter(queue: JobQueueName, idempotencyKey: string): Promise<Job<T> | undefined> {
    const stored = await this.findDeadLetter(queue, idempotencyKey);
    if (stored === undefined) return undefined;
    const data = stored.data as BullMqDeadLetterEnvelope<T>;
    await this.deadLetterQueue(queue).remove(stored.id);
    const job = { ...data.job, attempts: 0, availableAt: Date.now() };
    await this.enqueue(queue, job);
    return job;
  }

  async discardDeadLetter(queue: JobQueueName, idempotencyKey: string): Promise<boolean> {
    const stored = await this.findDeadLetter(queue, idempotencyKey);
    if (stored === undefined) return false;
    await this.deadLetterQueue(queue).remove(stored.id);
    return true;
  }

  private async findDeadLetter(
    queue: JobQueueName,
    idempotencyKey: string,
  ): Promise<BullMqStoredJob<unknown> | undefined> {
    const stored = await this.deadLetterQueue(queue).getJobs(
      ['waiting', 'delayed', 'prioritized'],
      0,
      -1,
      true,
    );
    return stored.find((candidate) => {
      const data = candidate.data as BullMqDeadLetterEnvelope<T>;
      return data.job.idempotencyKey === idempotencyKey;
    });
  }

  private queue(queue: JobQueueName): BullMqQueue<unknown> {
    const existing = this.queues.get(queue);
    if (existing !== undefined) return existing;
    const created = this.queueFactory(this.queueName(queue));
    this.queues.set(queue, created);
    return created;
  }

  private deadLetterQueue(queue: JobQueueName): BullMqQueue<unknown> {
    return this.queueFactory(this.queueName(`${queue}:dead-letter`));
  }

  private queueName(queue: string): string {
    return bullMqQueueName(this.namespace, this.organizationId, queue);
  }

  private jobId(job: Job<T>): string {
    return `${this.organizationId}__${job.idempotencyKey}`.replaceAll(':', '_');
  }
}

type JobState = 'PENDING' | 'CLAIMED' | 'DEAD';
interface JobEntity extends TenantEntity {
  readonly queueName: JobQueueName;
  readonly state: JobState;
  readonly job: Job<unknown>;
  readonly leaseUntil?: number;
  readonly error?: string;
}

/** Repository-backed transport for deployments without a Redis/BullMQ adapter.
 * Claims use repository CAS and an expiring lease so a process restart can
 * reclaim jobs left in CLAIMED state. */
export class RepositoryJobTransport<T> implements DurableJobTransport<T>, JobDeadLetterAdmin<T> {
  private readonly repository: Repository<JobEntity>;
  private lock: Promise<void> = Promise.resolve();

  constructor(
    repositoryFactory: <E extends TenantEntity>(name: RepositoryName) => Repository<E>,
    private readonly organizationId: string,
    private readonly leaseMs = 60_000,
  ) {
    if (organizationId === '') throw new ValidationError('Job organization is required');
    if (leaseMs < 1) throw new ValidationError('Job lease must be positive');
    this.repository = repositoryFactory<JobEntity>(repositoryName('jobs'));
  }

  enqueue(queue: JobQueueName, job: Job<T>): Promise<void> {
    return this.serial(async () => {
      const existing = await this.findQueue(
        queue,
        (item) => item.job.idempotencyKey === job.idempotencyKey && item.state !== 'DEAD',
      );
      if (existing !== undefined) return;
      const now = new Date();
      await this.repository.insert({
        id: `${queue}:${job.id}`,
        tenantId: this.organizationId,
        version: 1,
        createdAt: now,
        updatedAt: now,
        queueName: queue,
        state: 'PENDING',
        job,
      });
    });
  }

  dequeue(queue: JobQueueName): Promise<Job<T> | undefined> {
    return this.serial(async () => {
      const now = Date.now();
      const candidate = await this.findQueue(
        queue,
        (item) =>
          (item.state === 'PENDING' && item.job.availableAt <= now) ||
          (item.state === 'CLAIMED' && (item.leaseUntil ?? 0) <= now),
      );
      if (candidate === undefined) return undefined;
      const claimed: JobEntity = {
        ...candidate,
        version: candidate.version + 1,
        updatedAt: new Date(),
        state: 'CLAIMED',
        leaseUntil: now + this.leaseMs,
      };
      await this.repository.update(claimed, candidate.version);
      return claimed.job as Job<T>;
    });
  }

  requeue(queue: JobQueueName, job: Job<T>, delayMs: number): Promise<void> {
    return this.serial(() =>
      this.updateState(queue, job.id, 'PENDING', { ...job, availableAt: Date.now() + delayMs }),
    );
  }

  deadLetter(queue: JobQueueName, job: Job<T>, error: unknown): Promise<void> {
    return this.serial(() =>
      this.updateState(
        queue,
        job.id,
        'DEAD',
        job,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  async backlog(queue: JobQueueName): Promise<number> {
    const items = await this.listQueue(queue);
    return items.filter((item) => item.state !== 'DEAD').length;
  }

  deleteBySubject(queue: JobQueueName, subjectId: string): Promise<number> {
    if (subjectId.trim() === '') throw new ValidationError('Job subject is required');
    return this.serial(async () => {
      let removed = 0;
      for (const item of await this.listQueue(queue)) {
        if (containsSubject(item.job.payload, subjectId)) {
          await this.repository.delete(this.organizationId, item.id, item.version);
          removed += 1;
        }
      }
      return removed;
    });
  }

  async listDeadLetters(queue: JobQueueName): Promise<readonly DeadLetterJob<T>[]> {
    return (await this.listQueue(queue))
      .filter((item) => item.state === 'DEAD')
      .map((item) => ({
        job: item.job as Job<T>,
        error: item.error ?? 'Unknown job failure',
        deadLetteredAt: item.updatedAt,
      }));
  }

  async retryDeadLetter(queue: JobQueueName, idempotencyKey: string): Promise<Job<T> | undefined> {
    return this.serial(async () => {
      const item = (await this.listQueue(queue)).find(
        (candidate) =>
          candidate.state === 'DEAD' && candidate.job.idempotencyKey === idempotencyKey,
      );
      if (item === undefined) return undefined;
      const job = { ...item.job, attempts: 0, availableAt: Date.now() } as Job<T>;
      const withoutError = { ...item };
      delete withoutError.error;
      await this.repository.update(
        {
          ...withoutError,
          version: item.version + 1,
          updatedAt: new Date(),
          state: 'PENDING',
          job,
        },
        item.version,
      );
      return job;
    });
  }

  async discardDeadLetter(queue: JobQueueName, idempotencyKey: string): Promise<boolean> {
    return this.serial(async () => {
      const item = (await this.listQueue(queue)).find(
        (candidate) =>
          candidate.state === 'DEAD' && candidate.job.idempotencyKey === idempotencyKey,
      );
      return item === undefined
        ? false
        : this.repository.delete(this.organizationId, item.id, item.version);
    });
  }

  private async updateState(
    queue: JobQueueName,
    id: string,
    state: JobState,
    job: Job<T>,
    error?: string,
  ): Promise<void> {
    const current = await this.repository.findById(this.organizationId, `${queue}:${id}`);
    if (current === undefined) return;
    await this.repository.update(
      {
        ...current,
        version: current.version + 1,
        updatedAt: new Date(),
        state,
        job,
        ...(error === undefined ? {} : { error }),
        ...(state === 'PENDING' ? { leaseUntil: 0 } : {}),
      },
      current.version,
    );
  }

  private async listQueue(queue: JobQueueName): Promise<readonly JobEntity[]> {
    const values: JobEntity[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.repository.list(this.organizationId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      values.push(...page.items.filter((item) => item.queueName === queue));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return values;
  }

  private async findQueue(
    queue: JobQueueName,
    predicate: (item: JobEntity) => boolean,
  ): Promise<JobEntity | undefined> {
    return (await this.listQueue(queue))
      .filter(predicate)
      .sort(
        (left, right) =>
          right.job.priority - left.job.priority ||
          left.job.createdAt.getTime() - right.job.createdAt.getTime(),
      )[0];
  }

  private serial<R>(operation: () => Promise<R>): Promise<R> {
    const next = this.lock.then(operation, operation);
    this.lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export interface DistributedJobQueueOptions extends JobOptions {
  readonly transport: DurableJobTransport<unknown>;
}

/**
 * Queue facade for Redis/BullMQ deployments.  Admission control happens before
 * handing a job to the transport, while retry and dead-letter policy remains in
 * this package so every transport has identical semantics.
 */
export class DistributedJobQueue<T> {
  private readonly options: Required<Omit<JobOptions, 'maxBacklog'>> & {
    maxBacklog: number;
  };
  constructor(
    readonly name: JobQueueName,
    private readonly transport: DurableJobTransport<T>,
    options: JobOptions = {},
    private readonly observe?: JobObservationSink,
  ) {
    this.options = {
      maxBacklog: options.maxBacklog ?? 1000,
      maxAttempts: options.maxAttempts ?? 3,
      timeoutMs: options.timeoutMs ?? 30_000,
      retryBaseMs: options.retryBaseMs ?? 100,
      retryJitterMs: options.retryJitterMs ?? 50,
      retentionMs: options.retentionMs ?? 86_400_000,
      retryAfterSeconds: options.retryAfterSeconds ?? 5,
    };
    if (
      !Number.isInteger(this.options.maxBacklog) ||
      this.options.maxBacklog < 1 ||
      !Number.isInteger(this.options.maxAttempts) ||
      this.options.maxAttempts < 1
    )
      throw new ValidationError('Job queue limits must be positive integers');
    if (
      !Number.isInteger(this.options.timeoutMs) ||
      this.options.timeoutMs < 1 ||
      this.options.timeoutMs > 86_400_000
    )
      throw new ValidationError('Job timeout is invalid');
    if (
      !Number.isInteger(this.options.retryBaseMs) ||
      this.options.retryBaseMs < 0 ||
      this.options.retryBaseMs > 86_400_000
    )
      throw new ValidationError('Job retry base is invalid');
    if (
      !Number.isInteger(this.options.retryJitterMs) ||
      this.options.retryJitterMs < 0 ||
      this.options.retryJitterMs > 86_400_000
    )
      throw new ValidationError('Job retry jitter is invalid');
    if (!Number.isInteger(this.options.retentionMs) || this.options.retentionMs < 1)
      throw new ValidationError('Job retention is invalid');
    if (
      !Number.isInteger(this.options.retryAfterSeconds) ||
      this.options.retryAfterSeconds < 0 ||
      this.options.retryAfterSeconds > 86_400
    )
      throw new ValidationError('Job retry-after is invalid');
  }
  async enqueue(input: {
    id: string;
    payload: T;
    idempotencyKey: string;
    priority?: number;
    delayMs?: number;
    context?: JobExecutionContext;
  }): Promise<Job<T>> {
    if (input.id.trim() === '') throw new ValidationError('Job id is required');
    if (input.idempotencyKey === '') throw new ValidationError('Idempotency key is required');
    if (input.priority !== undefined && !Number.isFinite(input.priority))
      throw new ValidationError('Job priority must be finite');
    if (
      input.delayMs !== undefined &&
      (!Number.isInteger(input.delayMs) || input.delayMs < 0 || input.delayMs > 2_592_000_000)
    )
      throw new ValidationError('Job delay is invalid');
    const backlog = await withTransportBoundary('backlog', this.options.retryAfterSeconds, () =>
      this.transport.backlog(this.name),
    );
    if (backlog >= this.options.maxBacklog)
      throw new BackpressureError(this.options.retryAfterSeconds);
    const job: Job<T> = {
      id: input.id,
      queue: this.name,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      priority: input.priority ?? 0,
      attempts: 0,
      availableAt: Date.now() + (input.delayMs ?? 0),
      createdAt: new Date(),
      ...(input.context === undefined ? {} : { context: input.context }),
    };
    await this.observedOperation('enqueue', () => this.transport.enqueue(this.name, job));
    return job;
  }
  async process(
    handler: (payload: T, context: JobContext) => Promise<void>,
    signal?: AbortSignal,
    options: JobProcessOptions = {},
  ): Promise<JobResult<T> | undefined> {
    const started = performance.now();
    let job: Job<T> | undefined;
    try {
      job = await withTransportBoundary('dequeue', this.options.retryAfterSeconds, () =>
        this.transport.dequeue(this.name),
      );
      this.observe?.({
        operation: 'dequeue',
        queue: this.name,
        outcome: 'success',
        durationMs: elapsed(started),
      });
    } catch (error) {
      this.observe?.({
        operation: 'dequeue',
        queue: this.name,
        outcome: 'error',
        durationMs: elapsed(started),
      });
      throw error;
    }
    if (job === undefined) return undefined;
    options.onJob?.(job);
    if (signal?.aborted) {
      await this.observedOperation('requeue', () => this.transport.requeue(this.name, job, 0));
      return { status: 'CANCELLED', job };
    }
    const executionStarted = performance.now();
    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let checkpoint: JobCheckpoint = { attempt: job.attempts };
    const context: JobContext = {
      signal: controller.signal,
      ...(job.context ?? {}),
      heartbeat: () => options.onHeartbeat?.(Date.now()),
      checkpoint: (value) => {
        checkpoint = { attempt: job.attempts, value };
        return Promise.resolve();
      },
    };
    try {
      await withTimeout(handler(job.payload, context), this.options.timeoutMs, controller);
      if (controller.signal.aborted && signal?.aborted) {
        await this.observedOperation('requeue', () => this.transport.requeue(this.name, job, 0));
        return { status: 'CANCELLED', job };
      }
      this.observe?.({
        operation: 'completed',
        queue: this.name,
        outcome: 'success',
        durationMs: elapsed(executionStarted),
      });
      return { status: 'COMPLETED', job };
    } catch (error) {
      if (controller.signal.aborted && signal?.aborted) {
        await this.observedOperation('requeue', () => this.transport.requeue(this.name, job, 0));
        return { status: 'CANCELLED', job };
      }
      const attempts = job.attempts + 1;
      const retryAfterMs = retryDelay(this.options, attempts);
      const retryJob = {
        ...job,
        attempts,
        availableAt: Date.now() + retryAfterMs,
      };
      if (attempts >= this.options.maxAttempts) {
        await this.observedOperation('dead-letter', () =>
          this.transport.deadLetter(this.name, retryJob, error),
        );
        this.observe?.({
          operation: 'dead-letter',
          queue: this.name,
          outcome: 'success',
          durationMs: elapsed(executionStarted),
        });
        return { status: 'DEAD_LETTERED', job: retryJob, error, checkpoint };
      }
      await this.observedOperation('requeue', () =>
        this.transport.requeue(this.name, retryJob, retryAfterMs),
      );
      this.observe?.({
        operation: 'retry',
        queue: this.name,
        outcome: 'success',
        durationMs: elapsed(executionStarted),
      });
      return { status: 'RETRY_SCHEDULED', job: retryJob, error, checkpoint };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
  get backlog(): Promise<number> {
    return withTransportBoundary('backlog', this.options.retryAfterSeconds, () =>
      this.transport.backlog(this.name),
    );
  }

  deleteBySubject(subjectId: string): Promise<number> {
    if (this.transport.deleteBySubject === undefined)
      throw new ValidationError('Job transport does not support subject deletion');
    return this.transport.deleteBySubject(this.name, subjectId);
  }

  async listDeadLetters(): Promise<readonly DeadLetterJob<T>[]> {
    return this.admin().listDeadLetters(this.name);
  }

  async retryDeadLetter(idempotencyKey: string): Promise<Job<T> | undefined> {
    return this.admin().retryDeadLetter(this.name, idempotencyKey);
  }

  async discardDeadLetter(idempotencyKey: string): Promise<boolean> {
    return this.admin().discardDeadLetter(this.name, idempotencyKey);
  }

  private admin(): JobDeadLetterAdmin<T> {
    const admin = this.transport as DurableJobTransport<T> & Partial<JobDeadLetterAdmin<T>>;
    if (
      admin.listDeadLetters === undefined ||
      admin.retryDeadLetter === undefined ||
      admin.discardDeadLetter === undefined
    )
      throw new ValidationError('Job transport does not support dead-letter administration');
    return admin as JobDeadLetterAdmin<T>;
  }

  private async observedOperation(
    operation: Extract<JobObservation['operation'], 'enqueue' | 'requeue' | 'dead-letter'>,
    action: () => Promise<void>,
  ): Promise<void> {
    const started = performance.now();
    try {
      await withTransportBoundary(operation, this.options.retryAfterSeconds, action);
      this.observe?.({
        operation,
        queue: this.name,
        outcome: 'success',
        durationMs: elapsed(started),
      });
    } catch (error) {
      this.observe?.({
        operation,
        queue: this.name,
        outcome: 'error',
        durationMs: elapsed(started),
      });
      throw error;
    }
  }
}

export interface JobWorkerOptions {
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly onHeartbeat?: (job: Job<unknown>, timestamp: number) => void;
  readonly onError?: (error: unknown) => void;
}

/** Runs a queue with bounded concurrency and a cooperative graceful stop. */
export class JobWorker<T> {
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly onHeartbeat: (job: Job<T>, timestamp: number) => void;
  private readonly onError: (error: unknown) => void;
  private stopping = false;
  private readonly controllers = new Set<AbortController>();
  private runPromise: Promise<void> | undefined;

  constructor(
    private readonly queue: DistributedJobQueue<T>,
    private readonly handler: (payload: T, context: JobContext) => Promise<void>,
    options: JobWorkerOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 1;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1)
      throw new ValidationError('Worker concurrency must be a positive integer');
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1)
      throw new ValidationError('Worker poll interval must be a positive integer');
    this.onHeartbeat = (job, timestamp) => options.onHeartbeat?.(job, timestamp);
    this.onError = (error) => options.onError?.(error);
  }

  start(): Promise<void> {
    if (this.runPromise !== undefined) return this.runPromise;
    this.stopping = false;
    this.runPromise = Promise.all(Array.from({ length: this.concurrency }, () => this.loop())).then(
      () => undefined,
    );
    return this.runPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.controllers) controller.abort();
    await this.runPromise;
    this.runPromise = undefined;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const controller = new AbortController();
      this.controllers.add(controller);
      let activeJob: Job<T> | undefined;
      try {
        const result = await this.queue.process(this.handler, controller.signal, {
          onJob: (job) => {
            activeJob = job as Job<T>;
          },
          onHeartbeat: (timestamp) => {
            if (activeJob !== undefined) this.onHeartbeat(activeJob, timestamp);
          },
        });
        if (result !== undefined) activeJob = result.job;
      } catch (error) {
        this.onError(error);
        await delay(this.pollIntervalMs);
      } finally {
        this.controllers.delete(controller);
      }
      await delay(this.pollIntervalMs);
    }
  }
}

export class InMemoryJobQueue<T> {
  private readonly pending: Job<T>[] = [];
  private readonly deadLetter: DeadLetterJob<T>[] = [];
  private readonly idempotency = new Set<string>();
  private readonly options: Required<JobOptions>;
  constructor(
    readonly name: JobQueueName,
    options: JobOptions = {},
  ) {
    this.options = {
      maxBacklog: options.maxBacklog ?? 1000,
      maxAttempts: options.maxAttempts ?? 3,
      timeoutMs: options.timeoutMs ?? 30_000,
      retryBaseMs: options.retryBaseMs ?? 100,
      retryJitterMs: options.retryJitterMs ?? 50,
      retentionMs: options.retentionMs ?? 86_400_000,
      retryAfterSeconds: options.retryAfterSeconds ?? 5,
    };
    if (
      !Number.isInteger(this.options.maxBacklog) ||
      this.options.maxBacklog < 1 ||
      !Number.isInteger(this.options.maxAttempts) ||
      this.options.maxAttempts < 1
    )
      throw new ValidationError('Job queue limits must be positive integers');
    if (
      !Number.isInteger(this.options.timeoutMs) ||
      this.options.timeoutMs < 1 ||
      this.options.timeoutMs > 86_400_000
    )
      throw new ValidationError('Job timeout is invalid');
    if (
      !Number.isInteger(this.options.retryBaseMs) ||
      this.options.retryBaseMs < 0 ||
      this.options.retryBaseMs > 86_400_000
    )
      throw new ValidationError('Job retry base is invalid');
    if (
      !Number.isInteger(this.options.retryJitterMs) ||
      this.options.retryJitterMs < 0 ||
      this.options.retryJitterMs > 86_400_000
    )
      throw new ValidationError('Job retry jitter is invalid');
    if (!Number.isInteger(this.options.retentionMs) || this.options.retentionMs < 1)
      throw new ValidationError('Job retention is invalid');
    if (
      !Number.isInteger(this.options.retryAfterSeconds) ||
      this.options.retryAfterSeconds < 0 ||
      this.options.retryAfterSeconds > 86_400
    )
      throw new ValidationError('Job retry-after is invalid');
  }
  enqueue(input: {
    id: string;
    payload: T;
    idempotencyKey: string;
    priority?: number;
    delayMs?: number;
    context?: JobExecutionContext;
  }): Job<T> {
    if (input.id.trim() === '') throw new ValidationError('Job id is required');
    if (input.idempotencyKey === '') throw new ValidationError('Idempotency key is required');
    if (input.priority !== undefined && !Number.isFinite(input.priority))
      throw new ValidationError('Job priority must be finite');
    if (
      input.delayMs !== undefined &&
      (!Number.isInteger(input.delayMs) || input.delayMs < 0 || input.delayMs > 2_592_000_000)
    )
      throw new ValidationError('Job delay is invalid');
    if (this.idempotency.has(input.idempotencyKey)) {
      const existing = this.pending.find((job) => job.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;
    }
    if (this.pending.length >= this.options.maxBacklog)
      throw new BackpressureError(this.options.retryAfterSeconds);
    const job: Job<T> = {
      id: input.id,
      queue: this.name,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      priority: input.priority ?? 0,
      attempts: 0,
      availableAt: Date.now() + (input.delayMs ?? 0),
      createdAt: new Date(),
      ...(input.context === undefined ? {} : { context: input.context }),
    };
    this.pending.push(job);
    this.idempotency.add(job.idempotencyKey);
    return job;
  }
  async process(
    handler: (payload: T, context: JobContext) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<JobResult | undefined> {
    const index = this.pending.findIndex((job) => job.availableAt <= Date.now());
    if (index < 0) return undefined;
    const job = this.pending.splice(index, 1)[0];
    if (job === undefined) return undefined;
    if (signal?.aborted) {
      this.pending.push(job);
      return { status: 'CANCELLED', job };
    }
    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let checkpoint: JobCheckpoint = { attempt: job.attempts };
    const context: JobContext = {
      signal: controller.signal,
      ...(job.context ?? {}),
      heartbeat: () => {
        return;
      },
      checkpoint: (value) => {
        checkpoint = { attempt: job.attempts, value };
        return Promise.resolve();
      },
    };
    try {
      await withTimeout(handler(job.payload, context), this.options.timeoutMs, controller);
      return { status: 'COMPLETED', job };
    } catch (error) {
      const nextAttempts = job.attempts + 1;
      const retryJob = {
        ...job,
        attempts: nextAttempts,
        availableAt: Date.now() + retryDelay(this.options, nextAttempts),
      };
      if (nextAttempts >= this.options.maxAttempts) {
        this.deadLetter.push({
          job: retryJob,
          error: error instanceof Error ? error.message : String(error),
          deadLetteredAt: new Date(),
        });
        return { status: 'DEAD_LETTERED', job: retryJob, error, checkpoint };
      }
      if (this.pending.length >= this.options.maxBacklog) {
        this.deadLetter.push({
          job: retryJob,
          error: error instanceof Error ? error.message : String(error),
          deadLetteredAt: new Date(),
        });
        return { status: 'DEAD_LETTERED', job: retryJob, error, checkpoint };
      }
      this.pending.push(retryJob);
      return { status: 'RETRY_SCHEDULED', job: retryJob, error, checkpoint };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
  get backlog(): number {
    return this.pending.length;
  }
  async deleteBySubject(subjectId: string): Promise<number> {
    if (subjectId.trim() === '') throw new ValidationError('Job subject is required');
    const before = this.pending.length + this.deadLetter.length;
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (containsSubject(this.pending[index]?.payload, subjectId)) {
        const removed = this.pending.splice(index, 1)[0];
        if (removed !== undefined) this.idempotency.delete(removed.idempotencyKey);
      }
    }
    for (let index = this.deadLetter.length - 1; index >= 0; index -= 1) {
      if (containsSubject(this.deadLetter[index]?.job.payload, subjectId)) {
        this.deadLetter.splice(index, 1);
      }
    }
    return Promise.resolve(before - this.pending.length - this.deadLetter.length);
  }
  get deadLetters(): readonly Job<T>[] {
    return this.deadLetter
      .filter((entry) => Date.now() - entry.deadLetteredAt.getTime() <= this.options.retentionMs)
      .map((entry) => entry.job);
  }
  listDeadLetters(): readonly DeadLetterJob<T>[] {
    return this.deadLetter.filter(
      (entry) => Date.now() - entry.deadLetteredAt.getTime() <= this.options.retentionMs,
    );
  }
  retryDeadLetter(idempotencyKey: string): Job<T> | undefined {
    const index = this.deadLetter.findIndex((entry) => entry.job.idempotencyKey === idempotencyKey);
    if (index < 0) return undefined;
    const entry = this.deadLetter.splice(index, 1)[0];
    if (entry === undefined) return undefined;
    const job = { ...entry.job, attempts: 0, availableAt: Date.now() };
    this.pending.push(job);
    return job;
  }
  discardDeadLetter(idempotencyKey: string): boolean {
    const index = this.deadLetter.findIndex((entry) => entry.job.idempotencyKey === idempotencyKey);
    if (index < 0) return false;
    this.deadLetter.splice(index, 1);
    this.idempotency.delete(idempotencyKey);
    return true;
  }
}

export interface JobResult<T = unknown> {
  readonly status: 'COMPLETED' | 'RETRY_SCHEDULED' | 'DEAD_LETTERED' | 'CANCELLED';
  readonly job: Job<T>;
  readonly error?: unknown;
  readonly checkpoint?: JobCheckpoint;
}

function containsSubject(value: unknown, subjectId: string, seen = new Set<object>()): boolean {
  if (value === subjectId) return true;
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSubject(item, subjectId, seen));
  return Object.values(value as Record<string, unknown>).some((item) =>
    containsSubject(item, subjectId, seen),
  );
}

export const operationRepository = repositoryName('operations');
export type OperationStatus =
  'PENDING' | 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';

/** Tenant-scoped durable resource for asynchronous API work (section 157). */
export interface Operation extends TenantEntity {
  readonly organizationId: string;
  readonly type: string;
  readonly idempotencyKey: string;
  readonly status: OperationStatus;
  readonly progress?: number;
  readonly result?: unknown;
  readonly errorCode?: string;
  readonly cancelRequested: boolean;
}

export interface OperationStore {
  get(organizationId: string, id: string): Promise<Operation | undefined>;
  findByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<Operation | undefined>;
  create(input: {
    readonly organizationId: string;
    readonly type: string;
    readonly idempotencyKey: string;
    readonly result?: unknown;
  }): Promise<Operation>;
  update(operation: Operation, expectedVersion: number): Promise<Operation>;
}

export class RepositoryOperationStore implements OperationStore {
  private readonly repository: Repository<Operation>;
  private readonly createLocks = new Map<string, Promise<Operation>>();

  constructor(repositoryFactory: <T extends TenantEntity>(name: RepositoryName) => Repository<T>) {
    this.repository = repositoryFactory<Operation>(operationRepository);
  }

  get(organizationId: string, id: string) {
    return this.repository.findById(organizationId, id);
  }

  async findByIdempotencyKey(organizationId: string, idempotencyKey: string) {
    const normalizedKey = idempotencyKey.trim();
    if (normalizedKey === '') throw new ValidationError('Idempotency key is required');
    let cursor: string | undefined;
    do {
      const page = await this.repository.list(organizationId, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const found = page.items.find((operation) => operation.idempotencyKey === normalizedKey);
      if (found !== undefined) return found;
      if (page.nextCursor !== undefined && page.nextCursor === cursor)
        throw new ValidationError('Operation repository cursor repeated');
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return undefined;
  }

  create(input: {
    organizationId: string;
    type: string;
    idempotencyKey: string;
    result?: unknown;
  }): Promise<Operation> {
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey === '') throw new ValidationError('Idempotency key is required');
    const lockKey = `${input.organizationId}:${idempotencyKey}`;
    const previous = this.createLocks.get(lockKey);
    const create = (async () => {
      if (previous !== undefined) await previous.catch(() => undefined);
      const existing = await this.findByIdempotencyKey(input.organizationId, idempotencyKey);
      if (existing !== undefined) {
        if (existing.type !== input.type)
          throw new ValidationError('Operation idempotency conflict');
        return existing;
      }
      const now = new Date();
      const operation: Operation = {
        id: uuidV7(),
        tenantId: input.organizationId,
        organizationId: input.organizationId,
        type: input.type,
        idempotencyKey,
        status: 'PENDING',
        cancelRequested: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
        ...(input.result === undefined ? {} : { result: input.result }),
      };
      return this.repository.insert(operation);
    })();
    this.createLocks.set(lockKey, create);
    return create.finally(() => {
      if (this.createLocks.get(lockKey) === create) this.createLocks.delete(lockKey);
    });
  }

  update(operation: Operation, expectedVersion: number) {
    return this.repository.findById(operation.organizationId, operation.id).then((current) => {
      if (current === undefined) throw new ValidationError('Operation was not found');
      if (current.version !== expectedVersion)
        throw new ValidationError('Operation version conflict');
      validateOperationMutation(current, operation);
      validateOperationTransition(current.status, operation.status);
      return this.repository.update(
        { ...operation, version: expectedVersion + 1, updatedAt: new Date() },
        expectedVersion,
      );
    });
  }
}

export class InMemoryOperationStore implements OperationStore {
  private readonly values = new Map<string, Operation>();
  private readonly idempotency = new Map<string, string>();

  get(organizationId: string, id: string) {
    return Promise.resolve(this.values.get(`${organizationId}:${id}`));
  }

  findByIdempotencyKey(organizationId: string, idempotencyKey: string) {
    const normalizedKey = idempotencyKey.trim();
    if (normalizedKey === '')
      return Promise.reject(new ValidationError('Idempotency key is required'));
    const id = this.idempotency.get(`${organizationId}:${normalizedKey}`);
    return id === undefined ? Promise.resolve(undefined) : this.get(organizationId, id);
  }

  async create(input: {
    organizationId: string;
    type: string;
    idempotencyKey: string;
    result?: unknown;
  }) {
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey === '') throw new ValidationError('Idempotency key is required');
    const existing = await this.findByIdempotencyKey(input.organizationId, idempotencyKey);
    if (existing !== undefined) {
      if (existing.type !== input.type) throw new ValidationError('Operation idempotency conflict');
      return existing;
    }
    const now = new Date();
    const operation: Operation = {
      id: uuidV7(),
      tenantId: input.organizationId,
      organizationId: input.organizationId,
      type: input.type,
      idempotencyKey,
      status: 'PENDING',
      cancelRequested: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...(input.result === undefined ? {} : { result: input.result }),
    };
    this.values.set(`${input.organizationId}:${operation.id}`, operation);
    this.idempotency.set(`${input.organizationId}:${idempotencyKey}`, operation.id);
    return operation;
  }

  update(operation: Operation, expectedVersion: number) {
    const key = `${operation.organizationId}:${operation.id}`;
    const current = this.values.get(key);
    if (current === undefined)
      return Promise.reject(new ValidationError('Operation was not found'));
    if (current.version !== expectedVersion) return Promise.reject(new Error('Operation conflict'));
    try {
      validateOperationMutation(current, operation);
      validateOperationTransition(current.status, operation.status);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Operation update failed'));
    }
    const updated = { ...operation, version: expectedVersion + 1, updatedAt: new Date() };
    this.values.set(key, updated);
    return Promise.resolve(updated);
  }
}

function validateOperationMutation(current: Operation, next: Operation): void {
  if (
    current.id !== next.id ||
    current.tenantId !== next.tenantId ||
    current.organizationId !== next.organizationId ||
    current.type !== next.type ||
    current.idempotencyKey !== next.idempotencyKey
  )
    throw new ValidationError('Operation identity is immutable');
  if (
    next.progress !== undefined &&
    (!Number.isFinite(next.progress) || next.progress < 0 || next.progress > 100)
  )
    throw new ValidationError('Operation progress must be between 0 and 100');
}

function validateOperationTransition(from: OperationStatus, to: OperationStatus): void {
  if (from === to) return;
  const allowed: Record<OperationStatus, readonly OperationStatus[]> = {
    PENDING: ['RUNNING', 'CANCELLED', 'EXPIRED', 'FAILED'],
    RUNNING: ['WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
    WAITING: ['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
    SUCCEEDED: [],
    FAILED: [],
    CANCELLED: [],
    EXPIRED: [],
  };
  if (!allowed[from].includes(to))
    throw new ValidationError(`Invalid operation transition: ${from} -> ${to}`);
}

async function withTransportBoundary<T>(
  operation: JobTransportUnavailableError['operation'],
  retryAfterSeconds: number,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof JobTransportUnavailableError) throw error;
    throw new JobTransportUnavailableError(operation, retryAfterSeconds, error);
  }
}
async function withTimeout<T>(
  operation: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Job timeout'));
    }, ms);
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function retryDelay(options: Required<JobOptions>, attempts: number): number {
  return (
    options.retryBaseMs * 2 ** Math.max(0, attempts - 1) +
    Math.floor(Math.random() * (options.retryJitterMs + 1))
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsed(started: number): number {
  return Math.max(0, performance.now() - started);
}
