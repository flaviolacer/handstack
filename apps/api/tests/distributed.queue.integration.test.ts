import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApplication } from '../src/main.js';
import { DatabaseService } from '../src/database/database.service.js';
import { OperationsRuntimeService } from '../src/operations/operations-runtime.service.js';
import { WorkflowRuntimeService } from '../src/workflows/workflow-runtime.service.js';
import { bullMqQueueName } from '@handstack/jobs';
import { Queue, Worker, type RedisOptions } from 'bullmq';

const redisUrl = process.env.HANDSTACK_TEST_REDIS_URL?.trim();
const configuredRedisUrl = redisUrl ?? '';

describe.skipIf(redisUrl === undefined || redisUrl === '')(
  'API runtime to Redis to worker integration',
  () => {
    const organizationId = 'api-worker-integration-org';
    const serviceToken = 'api-worker-integration-service-token-at-least-32-characters';
    const environmentKeys = [
      'HANDSTACK_DATABASE_ADAPTER',
      'HANDSTACK_DATABASE_URL',
      'HANDSTACK_DEPLOYMENT_PROFILE',
      'HANDSTACK_REDIS_URL',
      'HANDSTACK_ACCESS_TOKEN_SECRET',
      'HANDSTACK_TOKEN_PEPPER',
      'HANDSTACK_INTERNAL_SERVICE_TOKEN',
      'HANDSTACK_WORKER_ORGANIZATION_ID',
      'HANDSTACK_API_URL',
      'HANDSTACK_LOG_LEVEL',
    ] as const;
    const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    let app: NestFastifyApplication | undefined;
    let apiUrl = '';
    let queue: Queue<{ payload: unknown }, void> | undefined;
    let worker: Worker | undefined;
    let workerError: Error | undefined;

    beforeAll(async () => {
      process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
      process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
      process.env.HANDSTACK_DEPLOYMENT_PROFILE = 'distributed';
      process.env.HANDSTACK_REDIS_URL = configuredRedisUrl;
      process.env.HANDSTACK_ACCESS_TOKEN_SECRET =
        'distributed-queue-access-secret-at-least-32-characters';
      process.env.HANDSTACK_TOKEN_PEPPER = 'distributed-queue-token-pepper-at-least-32-characters';
      process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN = serviceToken;
      process.env.HANDSTACK_LOG_LEVEL = 'error';
      app = await createApplication();
      await app.init();
      await app.listen(0, '127.0.0.1');
      apiUrl = await app.getUrl();
      process.env.HANDSTACK_API_URL = apiUrl;
      process.env.HANDSTACK_WORKER_ORGANIZATION_ID = organizationId;
      const database = app.get(DatabaseService);
      expect(database.config.deployment.profile).toBe('distributed');
      expect(database.config.queue.redisUrl).toBe(configuredRedisUrl);
      const connection = redisConnection(configuredRedisUrl);
      const name = bullMqQueueName(
        database.config.queue.namespaces.queues,
        organizationId,
        'workflow-executions',
      );
      queue = new Queue<{ payload: unknown }, void>(name, { connection });
      worker = new Worker<{ payload: unknown }, void>(
        name,
        async (job) => {
          const response = await fetch(`${apiUrl}/internal/v1/workflows/execute`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${serviceToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(job.data.payload),
          });
          if (!response.ok)
            throw new Error(`Workflow execution returned HTTP ${String(response.status)}`);
          await response.arrayBuffer();
          await job.updateProgress({ checkpoint: { status: 'PROCESSED' } });
        },
        { connection, concurrency: 1 },
      );
      worker.on('error', (error) => {
        workerError = error instanceof Error ? error : new Error(String(error));
      });
      await queue.waitUntilReady();
      await worker.waitUntilReady();
    });

    afterAll(async () => {
      if (worker !== undefined) await worker.close();
      if (queue !== undefined) {
        await queue.obliterate({ force: true });
        await queue.close();
      }
      if (app !== undefined) await app.close();
      for (const key of environmentKeys) {
        const value = originalEnvironment.get(key);
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    });

    it('executes a durable workflow through API, Redis, a BullMQ worker and the internal API route', async () => {
      if (app === undefined || worker === undefined || queue === undefined)
        throw new Error('Distributed queue test setup failed');
      const activeApp = app;
      const activeQueue = queue;
      const runtime = activeApp.get(OperationsRuntimeService);
      const workflows = activeApp.get(WorkflowRuntimeService);
      const workflow = await workflows.create({
        organizationId,
        name: 'Redis worker integration',
        trigger: 'api',
        nodes: [{ id: 'finish', kind: 'Condition', config: {} }],
        edges: [],
      });
      await workflows.publish(organizationId, workflow.id);
      const idempotencyKey = `api-worker-${String(Date.now())}`;
      const operation = await workflows.startAsync({
        organizationId,
        workflowId: workflow.id,
        principalId: 'integration-principal',
        trigger: 'api',
        payload: { source: 'redis-http-integration' },
        idempotencyKey,
      });
      expect(operation.status).toBe('PENDING');
      const storedJobId = `${organizationId}__${idempotencyKey}`;
      const deadline = Date.now() + 10_000;
      let finalOperation = operation;
      let queueJob = await activeQueue.getJob(storedJobId);
      for (;;) {
        finalOperation = (await runtime.getOperation(organizationId, operation.id)) ?? operation;
        queueJob = await activeQueue.getJob(storedJobId);
        if (
          finalOperation.status === 'SUCCEEDED' &&
          queueJob !== undefined &&
          (await queueJob.isCompleted())
        )
          break;
        if (finalOperation.status === 'FAILED' || finalOperation.status === 'CANCELLED') {
          throw new Error(
            `Workflow operation ended as ${finalOperation.status}: ${finalOperation.errorCode ?? 'no error code'}`,
          );
        }
        if (workerError !== undefined) throw workerError;
        if (Date.now() >= deadline) {
          const counts = await activeQueue.getJobCounts(
            'waiting',
            'active',
            'completed',
            'failed',
            'delayed',
          );
          const jobs = await activeQueue.getJobs(
            ['waiting', 'active', 'completed', 'failed', 'delayed'],
            0,
            10,
            true,
          );
          throw new Error(
            `Timed out waiting for workflow completion (${JSON.stringify({ operation: finalOperation, storedJobId, counts, jobs: jobs.map((candidate) => ({ id: candidate.id, state: candidate.finishedOn === undefined ? 'pending' : 'finished' })) })})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(finalOperation).toMatchObject({
        status: 'SUCCEEDED',
        type: `workflow:${workflow.id}`,
      });
      expect(queueJob.progress).toMatchObject({ checkpoint: { status: 'PROCESSED' } });
      const executionId = (finalOperation.result as { executionId?: unknown }).executionId;
      expect(typeof executionId).toBe('string');
      await expect(
        workflows.getExecution(organizationId, executionId as string),
      ).resolves.toMatchObject({
        status: 'COMPLETED',
        idempotencyKey,
      });
    }, 20_000);
  },
);

function redisConnection(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl.replace('redis+', 'redis:'));
  return {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    ...(url.password === '' ? {} : { password: decodeURIComponent(url.password) }),
  };
}
