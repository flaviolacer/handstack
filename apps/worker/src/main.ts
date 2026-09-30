import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  Queue,
  Worker,
  type ConnectionOptions,
  type Job as BullJob,
  type RedisOptions,
} from 'bullmq';
import { Cluster } from 'ioredis';
import { configFromEnvironment, configLayerFromEnvironment } from '@handstack/config';
import {
  bullMqQueueName,
  JOB_QUEUES,
  type JobContext,
  type JobExecutionContext,
} from '@handstack/jobs';
import { PrometheusRegistry } from '@handstack/telemetry';

interface BullMqEnvelope {
  readonly id: string;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly createdAt: number;
  readonly context?: JobExecutionContext;
}

export interface WorkerRuntimeOptions {
  readonly redisUrl: string;
  readonly redisTopology: 'standalone' | 'sentinel' | 'cluster';
  readonly redisNatMap?: Record<string, { host: string; port: number }>;
  readonly namespace: string;
  readonly organizationId: string;
  readonly queue: (typeof JOB_QUEUES)[number];
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly maxAttempts: number;
  readonly retryJitterMs: number;
  readonly metricsPort: number;
}

export interface WorkerMetricsSnapshot {
  readonly activeJobs: number;
  readonly completedJobs: number;
  readonly failedJobs: number;
  readonly lastHeartbeatAt?: number;
}

export type WorkerQueueHandler = (payload: unknown, context: JobContext) => Promise<void>;
export type WorkerHandlerMap = Partial<Record<(typeof JOB_QUEUES)[number], WorkerQueueHandler>>;

export interface WorkerHandlerModule {
  readonly handlers: WorkerHandlerMap;
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
  queueOverride = process.argv[2],
): WorkerRuntimeOptions {
  const config = configFromEnvironment({
    ...environment,
    HANDSTACK_DEPLOYMENT_PROFILE: 'distributed',
  });
  if (config.queue.redisUrl === undefined)
    throw new Error('Distributed worker requires a Redis URL');
  const organizationId = config.worker.organizationId?.trim();
  const queue = config.worker.queue ?? queueOverride;
  if (organizationId === undefined || organizationId === '')
    throw new Error('HANDSTACK_WORKER_ORGANIZATION_ID is required');
  if (queue === undefined || !(JOB_QUEUES as readonly string[]).includes(queue))
    throw new Error('HANDSTACK_WORKER_QUEUE must be a supported queue');
  return {
    redisUrl: config.queue.redisUrl,
    redisTopology: config.queue.topology,
    redisNatMap: config.queue.natMap,
    namespace: config.queue.namespaces.queues,
    organizationId,
    queue: queue as (typeof JOB_QUEUES)[number],
    concurrency: config.worker.concurrency,
    timeoutMs:
      config.worker.timeoutMs ??
      timeoutForQueue(queue as (typeof JOB_QUEUES)[number], config.timeouts),
    heartbeatIntervalMs: config.worker.heartbeatIntervalMs,
    maxAttempts: config.worker.maxAttempts,
    retryJitterMs: config.worker.retryJitterMs,
    metricsPort: config.worker.metricsPort,
  };
}

function timeoutForQueue(
  queue: (typeof JOB_QUEUES)[number],
  timeouts: ReturnType<typeof configFromEnvironment>['timeouts'],
): number {
  switch (queue) {
    case 'agents':
      return timeouts.agent;
    case 'embeddings':
      return timeouts.provider;
    case 'indexing':
      return timeouts.workflow;
    case 'documents':
    case 'webhooks':
      return timeouts.http;
    case 'plugins':
      return timeouts.tool;
    case 'audit':
    case 'billing':
    case 'cleanup':
    case 'workflow-executions':
      return timeouts.workflow;
  }
}

export function redisConnection(
  redisUrl: string,
  topology: 'standalone' | 'sentinel' | 'cluster' = 'standalone',
  natMap: Record<string, { host: string; port: number }> = {},
): ConnectionOptions {
  const url = new URL(redisUrl.replace(/^redis\+(?:sentinel|cluster):\/\//u, 'redis://'));
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:')
    throw new Error('Redis URL is invalid');
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
  if (topology === 'standalone') return options;
  if (topology === 'sentinel')
    return {
      ...options,
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

export function workerQueueName(
  options: Pick<WorkerRuntimeOptions, 'namespace' | 'organizationId' | 'queue'>,
): string {
  return bullMqQueueName(options.namespace, options.organizationId, options.queue);
}

/** Loads the domain handlers explicitly configured for the distributed worker. */
export async function loadWorkerHandlers(
  modulePath = configLayerFromEnvironment(process.env).worker?.handlerModule,
): Promise<WorkerHandlerMap> {
  if (modulePath === undefined || modulePath.trim() === '') {
    throw new Error('HANDSTACK_WORKER_HANDLER_MODULE is required for distributed workers');
  }
  const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    readonly default?: unknown;
    readonly handlers?: unknown;
  };
  const candidate = loaded.handlers ?? loaded.default;
  if (!isHandlerMap(candidate)) throw new Error('Worker handler module must export a handlers map');
  return candidate;
}

export function selectWorkerHandler(
  queue: (typeof JOB_QUEUES)[number],
  handlers: WorkerHandlerMap,
): WorkerQueueHandler {
  const handler = handlers[queue];
  if (handler === undefined)
    throw new Error(`Worker handler is not configured for queue: ${queue}`);
  return handler;
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
  const connection = redisConnection(
    options.redisUrl,
    options.redisTopology,
    options.redisNatMap ?? {},
  );
  const name = workerQueueName(options);
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: options.maxAttempts,
      backoff: { type: 'exponential', delay: 1000, jitter: options.retryJitterMs },
    },
  });
  // BullMQ queue names cannot contain ':'. Keep the DLQ in the same namespace
  // while using the same delimiter-safe convention as the primary queue.
  const deadLetterQueue = new Queue(`${name}__dead_letter`, { connection });
  const worker = new Worker<BullMqEnvelope>(
    name,
    async (job: BullJob<BullMqEnvelope>) => {
      const controller = new AbortController();
      const heartbeat = (): void => {
        metrics.recordHeartbeat();
        void job.updateProgress({ heartbeat: Date.now() });
      };
      const timer = setInterval(heartbeat, options.heartbeatIntervalMs);
      let timeout: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new Error('Job timed out');
          reject(error);
          controller.abort(error);
        }, options.timeoutMs);
      });
      const context: JobContext = {
        signal: controller.signal,
        ...(job.data.context ?? {}),
        heartbeat,
        checkpoint: (value) => job.updateProgress({ checkpoint: value }),
      };
      try {
        await Promise.race([handler(job.data.payload, context), timeoutPromise]);
        if (controller.signal.aborted) throw new Error('Job cancelled or timed out');
      } finally {
        clearInterval(timer);
        if (timeout !== undefined) clearTimeout(timeout);
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
          jobId: `${job.id ?? job.data.id}__dead-letter`.replaceAll(':', '_'),
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

export async function startProductionWorker(
  options = parseWorkerOptions(),
  metrics = new WorkerMetrics(),
): Promise<{ readonly runtime: WorkerRuntime; readonly metricsServer: MetricsServer }> {
  const handlers = await loadWorkerHandlers();
  const runtime = createBullMqWorker(
    options,
    selectWorkerHandler(options.queue, handlers),
    metrics,
  );
  const metricsServer = startWorkerMetricsServer(metrics, options.metricsPort);
  return { runtime, metricsServer };
}

function isHandlerMap(value: unknown): value is WorkerHandlerMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((handler) => typeof handler === 'function');
}

if (process.env.NODE_ENV !== 'test') {
  void startProductionWorker()
    .then(({ runtime, metricsServer }) => {
      const shutdown = async (): Promise<void> => {
        await metricsServer.close();
        await runtime.close();
      };
      process.once('SIGTERM', () => void shutdown());
      process.once('SIGINT', () => void shutdown());
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Worker startup failed'}\n`);
      process.exitCode = 1;
    });
}
