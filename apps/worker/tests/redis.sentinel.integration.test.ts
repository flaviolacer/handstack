import { afterEach, describe, expect, it } from 'vitest';
import { createBullMqWorker, type WorkerRuntimeOptions } from '../src/main.js';

const redisUrl = process.env.HANDSTACK_TEST_REDIS_URL?.trim();
const configuredRedisUrl = redisUrl ?? '';
const topology = process.env.HANDSTACK_TEST_REDIS_TOPOLOGY?.trim();

describe.skipIf(redisUrl === undefined || redisUrl === '' || topology !== 'sentinel')(
  'Redis Sentinel BullMQ integration',
  () => {
    const runtimes: ReturnType<typeof createBullMqWorker>[] = [];

    afterEach(async () => {
      await Promise.all(
        runtimes.splice(0).map(async (runtime) => {
          await runtime.queue.obliterate({ force: true });
          await runtime.close();
        }),
      );
    });

    it('publishes and consumes through the monitored master', async () => {
      const options: WorkerRuntimeOptions = {
        redisUrl: configuredRedisUrl,
        redisTopology: 'sentinel',
        namespace: `handstack-sentinel-${String(Date.now())}`,
        organizationId: 'sentinel-integration-org',
        queue: 'agents',
        concurrency: 1,
        timeoutMs: 5_000,
        heartbeatIntervalMs: 50,
        maxAttempts: 1,
        retryJitterMs: 1,
        metricsPort: 19_092,
      };
      const runtime = createBullMqWorker(options, async (payload, context) => {
        context.heartbeat();
        await context.checkpoint({ payload, status: 'SENTINEL_OK' });
      });
      runtimes.push(runtime);
      const enqueueAndWait = async (
        activeRuntime: ReturnType<typeof createBullMqWorker>,
        id: string,
        source: string,
      ): Promise<void> => {
        const job = await activeRuntime.queue.add(
          'sentinel-integration',
          {
            id,
            payload: { source },
            idempotencyKey: id,
            attempts: 1,
            createdAt: Date.now(),
          },
          { jobId: id },
        );
        const deadline = Date.now() + 20_000;
        while (!(await job.isCompleted())) {
          if (Date.now() >= deadline) throw new Error(`Timed out waiting for Sentinel job: ${id}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(await job.getState()).toBe('completed');
      };
      await enqueueAndWait(runtime, 'sentinel-job-before-failover', 'sentinel-before-failover');
      if (process.env.HANDSTACK_TEST_REDIS_FAILOVER === 'true') {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        await runtime.close();
        runtimes.splice(runtimes.indexOf(runtime), 1);
        const recoveredRuntime = createBullMqWorker(options, async (payload, context) => {
          context.heartbeat();
          await context.checkpoint({ payload, status: 'SENTINEL_RECOVERED' });
        });
        runtimes.push(recoveredRuntime);
        await enqueueAndWait(
          recoveredRuntime,
          'sentinel-job-after-failover',
          'sentinel-after-failover',
        );
      }
    }, 30_000);
  },
);
