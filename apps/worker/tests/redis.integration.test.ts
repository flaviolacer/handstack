import { afterEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { RedisAuditAppendCoordinator } from '@handstack/audit';
import type { JobContext } from '@handstack/jobs';
import { JOB_QUEUES } from '@handstack/jobs';
import {
  createBullMqWorker,
  redisConnection,
  workerQueueName,
  type WorkerRuntimeOptions,
} from '../src/main.js';

const redisUrl = process.env.HANDSTACK_TEST_REDIS_URL?.trim();
const configuredRedisUrl = redisUrl ?? '';

describe.skipIf(redisUrl === undefined || redisUrl === '')(
  'distributed worker and BullMQ integration',
  () => {
    const runtimes: ReturnType<typeof createBullMqWorker>[] = [];
    const deadLetterQueues: Queue[] = [];

    afterEach(async () => {
      await Promise.all(
        runtimes.splice(0).map(async (runtime) => {
          await runtime.queue.obliterate({ force: true });
          await runtime.close();
        }),
      );
      await Promise.all(
        deadLetterQueues.splice(0).map(async (queue) => {
          await queue.obliterate({ force: true });
          await queue.close();
        }),
      );
    });

    it('keeps audit append critical sections mutually exclusive across coordinators', async () => {
      const client = new Redis(configuredRedisUrl);
      const keyPrefix = `handstack:test:audit-lock:${String(Date.now())}`;
      const lockClient = {
        set: async (key: string, value: string, ...options: readonly string[]) => {
          const result = await client.call('SET', key, value, ...options);
          return result === 'OK' ? 'OK' : null;
        },
        eval: (script: string, numberOfKeys: number, ...arguments_: readonly string[]) =>
          client.eval(script, numberOfKeys, ...arguments_),
      };
      const coordinators = [
        new RedisAuditAppendCoordinator(lockClient, { keyPrefix, waitMs: 5_000, retryMs: 5 }),
        new RedisAuditAppendCoordinator(lockClient, { keyPrefix, waitMs: 5_000, retryMs: 5 }),
      ];
      let active = 0;
      let maximumActive = 0;
      const completed: number[] = [];
      try {
        await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            (async () => {
              const coordinator = coordinators[index % 2];
              if (coordinator === undefined) throw new Error('Audit coordinator is missing');
              return coordinator.withOrganizationLock('org-redis-lock', async () => {
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                await new Promise((resolve) => setTimeout(resolve, 20));
                completed.push(index);
                active -= 1;
              });
            })(),
          ),
        );
        expect(maximumActive).toBe(1);
        expect(completed).toHaveLength(8);
      } finally {
        await client.quit();
      }
    }, 15_000);

    it('renews a long-running audit lease and prevents a competing owner', async () => {
      const keyPrefix = `handstack:test:audit-renewal:${String(Date.now())}`;
      const organizationId = 'org-redis-renewal';
      const client = new Redis(configuredRedisUrl);
      const lockClient = {
        set: async (key: string, value: string, ...options: readonly string[]) => {
          const result = await client.call('SET', key, value, ...options);
          return result === 'OK' ? 'OK' : null;
        },
        eval: (script: string, numberOfKeys: number, ...arguments_: readonly string[]) =>
          client.eval(script, numberOfKeys, ...arguments_),
      };
      const owner = new RedisAuditAppendCoordinator(lockClient, {
        keyPrefix,
        leaseMs: 1_000,
        waitMs: 100,
        retryMs: 5,
      });
      const contender = new RedisAuditAppendCoordinator(lockClient, {
        keyPrefix,
        leaseMs: 1_000,
        waitMs: 100,
        retryMs: 5,
      });
      const key = `${keyPrefix}:${organizationId}`;
      try {
        await owner.withOrganizationLock(organizationId, async () => {
          await new Promise((resolve) => setTimeout(resolve, 700));
          expect(await client.pttl(key)).toBeGreaterThan(0);
          await expect(
            contender.withOrganizationLock(organizationId, () => Promise.resolve()),
          ).rejects.toThrow('Audit append lock could not be acquired');
          await new Promise((resolve) => setTimeout(resolve, 700));
        });
        expect(await client.exists(key)).toBe(0);
      } finally {
        await client.del(key);
        await client.quit();
      }
    }, 10_000);

    it('fails closed when an independent client removes the audit owner lease', async () => {
      const keyPrefix = `handstack:test:audit-loss:${String(Date.now())}`;
      const organizationId = 'org-redis-loss';
      const client = new Redis(configuredRedisUrl);
      const lockClient = {
        set: async (key: string, value: string, ...options: readonly string[]) => {
          const result = await client.call('SET', key, value, ...options);
          return result === 'OK' ? 'OK' : null;
        },
        eval: (script: string, numberOfKeys: number, ...arguments_: readonly string[]) =>
          client.eval(script, numberOfKeys, ...arguments_),
      };
      const coordinator = new RedisAuditAppendCoordinator(lockClient, {
        keyPrefix,
        leaseMs: 1_000,
        waitMs: 100,
        retryMs: 5,
      });
      const key = `${keyPrefix}:${organizationId}`;
      try {
        await expect(
          coordinator.withOrganizationLock(organizationId, async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await client.del(key);
            await new Promise((resolve) => setTimeout(resolve, 500));
          }),
        ).rejects.toThrow('Audit append lock lease was lost');
      } finally {
        await client.del(key);
        await client.quit();
      }
    }, 10_000);

    it('consumes one durable job in every official worker queue', async () => {
      const completed: string[] = [];
      for (const queue of JOB_QUEUES) {
        const options: WorkerRuntimeOptions = {
          redisUrl: configuredRedisUrl,
          redisTopology: 'standalone',
          namespace: `handstack-integration-${String(Date.now())}`,
          organizationId: 'integration-org',
          queue,
          concurrency: 1,
          timeoutMs: 5_000,
          heartbeatIntervalMs: 50,
          maxAttempts: 1,
          retryJitterMs: 1,
          metricsPort: 19_091,
        };
        const runtime = createBullMqWorker(options, async (payload, context: JobContext) => {
          context.heartbeat();
          await context.checkpoint({ queue, payload });
          completed.push(queue);
        });
        runtimes.push(runtime);
        const job = await runtime.queue.add(
          'integration',
          {
            id: `${queue}-job`,
            payload: { queue },
            idempotencyKey: `${queue}-idempotency`,
            attempts: 1,
            createdAt: Date.now(),
          },
          { jobId: `${queue}-integration` },
        );
        const deadline = Date.now() + 10_000;
        while (!(await job.isCompleted())) {
          if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${queue}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      expect(completed).toEqual([...JOB_QUEUES]);
    }, 60_000);

    it('retries and dead-letters a terminal failure in every official worker queue', async () => {
      const namespace = `handstack-retry-${String(Date.now())}`;
      for (const queueName of JOB_QUEUES) {
        const options: WorkerRuntimeOptions = {
          redisUrl: configuredRedisUrl,
          redisTopology: 'standalone',
          namespace,
          organizationId: 'retry-org',
          queue: queueName,
          concurrency: 1,
          timeoutMs: 5_000,
          heartbeatIntervalMs: 100,
          maxAttempts: 2,
          retryJitterMs: 1,
          metricsPort: 19_092,
        };
        let attempts = 0;
        const runtime = createBullMqWorker(options, async () => {
          attempts += 1;
          await Promise.resolve();
          throw new Error(`simulated ${queueName} failure`);
        });
        runtimes.push(runtime);
        const deadLetters = new Queue(`${workerQueueName(options)}__dead_letter`, {
          connection: redisConnection(configuredRedisUrl, 'standalone'),
        });
        deadLetterQueues.push(deadLetters);
        const jobId = `retry-${queueName}-${String(Date.now())}`;
        const job = await runtime.queue.add(
          'retry-test',
          {
            id: jobId,
            payload: { queue: queueName },
            idempotencyKey: `${jobId}-idempotency`,
            attempts: 0,
            createdAt: Date.now(),
          },
          { jobId },
        );

        const deadline = Date.now() + 10_000;
        let deadLetterJobs = await deadLetters.getJobs(['waiting']);
        while (deadLetterJobs.length === 0) {
          if (Date.now() >= deadline)
            throw new Error(`Timed out waiting for ${queueName} dead-letter job`);
          await new Promise((resolve) => setTimeout(resolve, 50));
          deadLetterJobs = await deadLetters.getJobs(['waiting']);
        }
        expect(await job.isFailed()).toBe(true);
        expect(attempts).toBe(2);
        expect(deadLetterJobs[0]?.data).toMatchObject({
          id: jobId,
          payload: { queue: queueName },
          idempotencyKey: `${jobId}-idempotency`,
          error: `simulated ${queueName} failure`,
        });
      }
    }, 60_000);

    it('aborts and fails a handler that exceeds its configured execution timeout', async () => {
      const options: WorkerRuntimeOptions = {
        redisUrl: configuredRedisUrl,
        redisTopology: 'standalone',
        namespace: `handstack-timeout-${String(Date.now())}`,
        organizationId: 'timeout-org',
        queue: 'agents',
        concurrency: 1,
        timeoutMs: 100,
        heartbeatIntervalMs: 50,
        maxAttempts: 1,
        retryJitterMs: 1,
        metricsPort: 19_093,
      };
      let observedAbort = false;
      const runtime = createBullMqWorker(options, async (_payload, context) => {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              reject(new Error('handler cancelled by timeout'));
            },
            { once: true },
          );
        });
      });
      runtimes.push(runtime);
      const deadLetters = new Queue(`${workerQueueName(options)}__dead_letter`, {
        connection: redisConnection(configuredRedisUrl, 'standalone'),
      });
      deadLetterQueues.push(deadLetters);
      const job = await runtime.queue.add(
        'timeout-test',
        {
          id: 'timeout-job',
          payload: {},
          idempotencyKey: `timeout-${String(Date.now())}`,
          attempts: 0,
          createdAt: Date.now(),
        },
        { jobId: `timeout-${String(Date.now())}` },
      );
      const deadline = Date.now() + 10_000;
      let deadLetterJobs = await deadLetters.getJobs(['waiting']);
      while (deadLetterJobs.length === 0) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for timeout dead-letter');
        await new Promise((resolve) => setTimeout(resolve, 50));
        deadLetterJobs = await deadLetters.getJobs(['waiting']);
      }
      expect(await job.isFailed()).toBe(true);
      expect(observedAbort).toBe(true);
      expect(deadLetterJobs[0]?.data).toMatchObject({ error: 'Job timed out' });
    }, 15_000);
  },
);
