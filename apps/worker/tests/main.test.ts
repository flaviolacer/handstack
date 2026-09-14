import { describe, expect, it } from 'vitest';
import {
  parseWorkerOptions,
  redisConnection,
  WorkerMetrics,
  workerQueueName,
  startWorkerMetricsServer,
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
      timeoutMs: 30_000,
      heartbeatIntervalMs: 10_000,
      maxAttempts: 3,
    });
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
    ).toBe('handstack:queues:org-test:agents');
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
});
