import { describe, expect, it } from 'vitest';
import {
  parseWorkerOptions,
  redisConnection,
  WorkerMetrics,
  workerQueueName,
  startWorkerMetricsServer,
  selectWorkerHandler,
  loadWorkerHandlers,
} from '../src/main.js';

describe('worker runtime configuration', () => {
  it('requires a queue, organization and distributed Redis', () => {
    expect(() => parseWorkerOptions({})).toThrow('requires a Redis URL');
    expect(() => parseWorkerOptions({ HANDSTACK_REDIS_URL: 'redis://localhost:6379' })).toThrow(
      'ORGANIZATION_ID',
    );
    expect(() =>
      parseWorkerOptions({
        HANDSTACK_REDIS_URL: 'redis://localhost:6379',
        HANDSTACK_WORKER_ORGANIZATION_ID: 'org-test',
        HANDSTACK_WORKER_QUEUE: 'unknown',
      }),
    ).toThrow('supported queue');
  });

  it('parses a tenant-scoped queue runtime', () => {
    expect(
      parseWorkerOptions({
        HANDSTACK_REDIS_URL: 'redis://localhost:6379/2',
        HANDSTACK_WORKER_ORGANIZATION_ID: 'org-test',
        HANDSTACK_WORKER_QUEUE: 'agents',
      }),
    ).toMatchObject({
      organizationId: 'org-test',
      queue: 'agents',
      concurrency: 1,
      timeoutMs: 120_000,
      heartbeatIntervalMs: 10_000,
      maxAttempts: 3,
    });
  });

  it('maps each worker queue to the corresponding configured timeout', () => {
    const base = {
      HANDSTACK_REDIS_URL: 'redis://localhost:6379/2',
      HANDSTACK_WORKER_ORGANIZATION_ID: 'org-test',
      HANDSTACK_HTTP_TIMEOUT_MS: '41000',
      HANDSTACK_PROVIDER_TIMEOUT_MS: '42000',
      HANDSTACK_TOOL_TIMEOUT_MS: '43000',
      HANDSTACK_AGENT_TIMEOUT_MS: '44000',
      HANDSTACK_WORKFLOW_TIMEOUT_MS: '45000',
    };
    const timeout = (queue: string): number =>
      parseWorkerOptions({ ...base, HANDSTACK_WORKER_QUEUE: queue }).timeoutMs;

    expect(timeout('agents')).toBe(44_000);
    expect(timeout('embeddings')).toBe(42_000);
    expect(timeout('indexing')).toBe(45_000);
    expect(timeout('documents')).toBe(41_000);
    expect(timeout('webhooks')).toBe(41_000);
    expect(timeout('plugins')).toBe(43_000);
    expect(timeout('workflow-executions')).toBe(45_000);
  });

  it('lets an explicit worker timeout override the queue-specific setting', () => {
    expect(
      parseWorkerOptions({
        HANDSTACK_REDIS_URL: 'redis://localhost:6379/2',
        HANDSTACK_WORKER_ORGANIZATION_ID: 'org-test',
        HANDSTACK_WORKER_QUEUE: 'agents',
        HANDSTACK_AGENT_TIMEOUT_MS: '44000',
        HANDSTACK_WORKER_TIMEOUT_MS: '50000',
      }).timeoutMs,
    ).toBe(50_000);
  });

  it('accepts the Helm worker class as a queue argument when env is omitted', () => {
    expect(
      parseWorkerOptions(
        {
          HANDSTACK_REDIS_URL: 'redis://localhost:6379/2',
          HANDSTACK_WORKER_ORGANIZATION_ID: 'org-test',
        },
        'agents',
      ),
    ).toMatchObject({ queue: 'agents' });
  });

  it('rejects invalid worker limits and builds a tenant queue name', () => {
    expect(() =>
      parseWorkerOptions({
        HANDSTACK_REDIS_URL: 'redis://localhost:6379',
        HANDSTACK_WORKER_ORGANIZATION_ID: 'org-test',
        HANDSTACK_WORKER_QUEUE: 'agents',
        HANDSTACK_WORKER_CONCURRENCY: '0',
      }),
    ).toThrow('concurrency');
    expect(
      workerQueueName({
        namespace: 'handstack:queues',
        organizationId: 'org-test',
        queue: 'agents',
      }),
    ).toBe('handstack_queues__org-test__agents');
  });

  it('parses TLS Redis connection details without connecting', () => {
    expect(redisConnection('rediss://user:secret@example.test:6380/2')).toMatchObject({
      host: 'example.test',
      port: 6380,
      username: 'user',
      password: 'secret',
      db: 2,
      tls: {},
    });
  });

  it('maps Sentinel topology to BullMQ sentinel connection options', () => {
    expect(
      redisConnection(
        'redis+sentinel://redis-sentinel.example:26379/2?master=handstack',
        'sentinel',
      ),
    ).toMatchObject({
      sentinels: [{ host: 'redis-sentinel.example', port: 26379 }],
      name: 'handstack',
      db: 2,
    });
  });

  it('applies the typed Redis NAT map to Sentinel connections', () => {
    expect(
      redisConnection('redis+sentinel://redis-sentinel.example:26379/0', 'sentinel', {
        'redis-sentinel.example:26379': { host: 'redis.internal', port: 26379 },
      }),
    ).toMatchObject({
      natMap: { 'redis-sentinel.example:26379': { host: 'redis.internal', port: 26379 } },
    });
  });

  it('tracks operational counters and the latest heartbeat without job payloads', () => {
    const metrics = new WorkerMetrics();
    expect(metrics.snapshot()).toEqual({
      activeJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
    });

    metrics.recordActive();
    metrics.recordHeartbeat(1234);
    metrics.recordCompleted();
    metrics.recordActive();
    metrics.recordFailed();

    expect(metrics.snapshot()).toEqual({
      activeJobs: 0,
      completedJobs: 1,
      failedJobs: 1,
      lastHeartbeatAt: 1234,
    });
  });

  it('serves Prometheus metrics without exposing job payloads', async () => {
    const metrics = new WorkerMetrics();
    metrics.recordActive();
    metrics.recordHeartbeat(2_000);
    const runtime = startWorkerMetricsServer(metrics, 0, '127.0.0.1');
    await new Promise<void>((resolve) => runtime.server.once('listening', resolve));
    const address = runtime.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Metrics server did not bind');
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/metrics`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('handstack_worker_jobs_active 1');
    expect(body).toContain('handstack_worker_last_heartbeat_timestamp_seconds 2');
    expect(body).not.toContain('payload');
    await runtime.close();
  });

  it('requires explicit domain handlers and selects only the configured queue handler', async () => {
    await expect(loadWorkerHandlers('')).rejects.toThrow('HANDSTACK_WORKER_HANDLER_MODULE');
    const handler = (): Promise<void> => Promise.resolve();
    expect(selectWorkerHandler('agents', { agents: handler })).toBe(handler);
    expect(() => selectWorkerHandler('agents', {})).toThrow('not configured');
  });
});
