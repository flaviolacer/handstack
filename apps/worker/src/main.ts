import { createServer, type Server } from 'node:http';
import { Queue, Worker, type Job as BullJob, type RedisOptions } from 'bullmq';
import { configFromEnvironment } from '@handstack/config';
import { JOB_QUEUES, type JobContext } from '@handstack/jobs';
import { PrometheusRegistry } from '@handstack/telemetry';

interface BullMqEnvelope {
  readonly id: string;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly createdAt: number;
}

export interface WorkerRuntimeOptions {
  readonly redisUrl: string;
  readonly namespace: string;
  readonly organizationId: string;
  readonly queue: (typeof JOB_QUEUES)[number];
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly maxAttempts: number;
  readonly metricsPort: number;
}

export interface WorkerMetricsSnapshot {
  readonly activeJobs: number;
  readonly completedJobs: number;
  readonly failedJobs: number;
  readonly lastHeartbeatAt?: number;
}

/** In-process operational metrics; callers can export the snapshot to their metrics backend. */
export class WorkerMetrics {
  private activeJobs = 0;
  private completedJobs = 0;
  private failedJobs = 0;
  private lastHeartbeatAt: number | undefined;

  recordActive(): void {
    this.activeJobs += 1;
  }

  recordCompleted(): void {
    this.activeJobs = Math.max(0, this.activeJobs - 1);
    this.completedJobs += 1;
  }

  recordFailed(): void {
    this.activeJobs = Math.max(0, this.activeJobs - 1);
    this.failedJobs += 1;
  }

  recordHeartbeat(timestamp = Date.now()): void {
    this.lastHeartbeatAt = timestamp;
  }

  snapshot(): WorkerMetricsSnapshot {
    return {
      activeJobs: this.activeJobs,
      completedJobs: this.completedJobs,
      failedJobs: this.failedJobs,
      ...(this.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: this.lastHeartbeatAt }),
    };
  }

  toPrometheus(): string {
    const snapshot = this.snapshot();
    const registry = new PrometheusRegistry();
    registry.set({
      name: 'handstack_worker_jobs_active',
      help: 'Jobs currently being processed by the worker',
      type: 'gauge',
      value: snapshot.activeJobs,
    });
    registry.set({
      name: 'handstack_worker_jobs_completed_total',
      help: 'Jobs completed by the worker',
      type: 'counter',
      value: snapshot.completedJobs,
    });
    registry.set({
      name: 'handstack_worker_jobs_failed_total',
      help: 'Jobs failed by the worker',
      type: 'counter',
      value: snapshot.failedJobs,
    });
    if (snapshot.lastHeartbeatAt !== undefined) {
      registry.set({
        name: 'handstack_worker_last_heartbeat_timestamp_seconds',
        help: 'Unix timestamp of the latest worker heartbeat',
        type: 'gauge',
        value: snapshot.lastHeartbeatAt / 1000,
      });
    }
    return registry.render();
  }
}

export function parseWorkerOptions(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkerRuntimeOptions {
  const config = configFromEnvironment({
    ...environment,
    HANDSTACK_DEPLOYMENT_PROFILE: 'distributed',
  });
  if (config.queue.redisUrl === undefined)
    throw new Error('Distributed worker requires a Redis URL');
  const organizationId = environment.HANDSTACK_WORKER_ORGANIZATION_ID?.trim();
  const queue = environment.HANDSTACK_WORKER_QUEUE;
  if (organizationId === undefined || organizationId === '')
    throw new Error('HANDSTACK_WORKER_ORGANIZATION_ID is required');
  if (queue === undefined || !(JOB_QUEUES as readonly string[]).includes(queue))
    throw new Error('HANDSTACK_WORKER_QUEUE must be a supported queue');
  return {
    redisUrl: config.queue.redisUrl,
    namespace: config.queue.namespaces.queues,
    organizationId,
    queue: queue as (typeof JOB_QUEUES)[number],
    concurrency: parsePositiveInt(environment.HANDSTACK_WORKER_CONCURRENCY, 1, 'concurrency'),
    timeoutMs: parsePositiveInt(environment.HANDSTACK_WORKER_TIMEOUT_MS, 30_000, 'timeout'),
    heartbeatIntervalMs: parsePositiveInt(
      environment.HANDSTACK_WORKER_HEARTBEAT_INTERVAL_MS,
      10_000,
      'heartbeat interval',
    ),
    maxAttempts: parsePositiveInt(environment.HANDSTACK_WORKER_MAX_ATTEMPTS, 3, 'max attempts'),
    metricsPort: parsePositiveInt(environment.HANDSTACK_WORKER_METRICS_PORT, 9091, 'metrics port'),
  };
}

export function redisConnection(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl.replace(/^redis\+/, 'redis:'));
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:')
    throw new Error('Redis URL is invalid');
  return {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    ...(url.username === '' ? {} : { username: decodeURIComponent(url.username) }),
    ...(url.password === '' ? {} : { password: decodeURIComponent(url.password) }),
    ...(url.pathname.length > 1 ? { db: Number(url.pathname.slice(1)) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export function workerQueueName(
  options: Pick<WorkerRuntimeOptions, 'namespace' | 'organizationId' | 'queue'>,
): string {
  return `${options.namespace}:${options.organizationId}:${options.queue}`;
}

export interface WorkerRuntime {
  readonly queue: Queue;
  readonly worker: Worker;
  readonly close: () => Promise<void>;
}

export interface MetricsServer {
  readonly server: Server;
  readonly close: () => Promise<void>;
}

export function startWorkerMetricsServer(
  metrics: WorkerMetrics,
  port: number,
  host = '0.0.0.0',
): MetricsServer {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    response.end(metrics.toPrometheus());
  });
  server.listen(port, host);
  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

/** Creates a real BullMQ worker; the domain handler receives a portable JobContext. */
export function createBullMqWorker(
  options: WorkerRuntimeOptions,
  handler: (payload: unknown, context: JobContext) => Promise<void>,
  metrics = new WorkerMetrics(),
): WorkerRuntime {
  const connection = redisConnection(options.redisUrl);
  const name = workerQueueName(options);
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: options.maxAttempts,
      backoff: { type: 'exponential', delay: 1000 },
    },
  });
  const deadLetterQueue = new Queue(`${name}:dead-letter`, { connection });
  const worker = new Worker<BullMqEnvelope>(
    name,
    async (job: BullJob<BullMqEnvelope>) => {
      const controller = new AbortController();
      const heartbeat = (): void => {
        metrics.recordHeartbeat();
        void job.updateProgress({ heartbeat: Date.now() });
      };
      const timer = setInterval(heartbeat, options.heartbeatIntervalMs);
      const timeout = setTimeout(() => {
        controller.abort();
      }, options.timeoutMs);
      const context: JobContext = {
        signal: controller.signal,
        heartbeat,
        checkpoint: (value) => job.updateProgress({ checkpoint: value }),
      };
      try {
        await handler(job.data.payload, context);
        if (controller.signal.aborted) throw new Error('Job cancelled or timed out');
      } finally {
        clearInterval(timer);
        clearTimeout(timeout);
      }
    },
    { connection, concurrency: options.concurrency, autorun: true },
  );
  worker.on('active', () => {
    metrics.recordActive();
  });
  worker.on('completed', () => {
    metrics.recordCompleted();
  });
  worker.on('failed', (job, error) => {
    metrics.recordFailed();
    if (job !== undefined && job.attemptsMade >= options.maxAttempts) {
      void deadLetterQueue.add(
        'job',
        { ...job.data, error: error.message },
        {
          jobId: `${job.id ?? job.data.id}:dead-letter`,
          removeOnComplete: true,
        },
      );
    }
  });
  return {
    queue,
    worker,
    close: async () => {
      worker.cancelAllJobs('graceful shutdown');
      await worker.close();
      await queue.close();
      await deadLetterQueue.close();
    },
  };
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`Worker ${label} must be a positive integer`);
  return parsed;
}

if (process.env.NODE_ENV !== 'test') {
  const options = parseWorkerOptions();
  const metrics = new WorkerMetrics();
  const runtime = createBullMqWorker(options, () => Promise.resolve(), metrics);
  const metricsServer = startWorkerMetricsServer(metrics, options.metricsPort);
  const shutdown = async (): Promise<void> => {
    await metricsServer.close();
    await runtime.close();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
