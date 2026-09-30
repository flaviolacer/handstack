import { IdentityAdministrationService } from '@handstack/identity-service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Queue, Worker, type RedisOptions } from 'bullmq';
import { bullMqQueueName } from '@handstack/jobs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthRuntimeService } from '../src/auth/auth-runtime.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { KnowledgeRuntimeService } from '../src/knowledge/knowledge-runtime.service.js';
import { ModelAdminRuntimeService } from '../src/models/model-admin-runtime.service.js';
import { createApplication } from '../src/main.js';

const redisUrl = process.env.HANDSTACK_TEST_REDIS_URL?.trim();
const organizationId = 'distributed-reindex-org';
const serviceToken = 'distributed-reindex-service-token-at-least-32-characters';

describe.skipIf(redisUrl === undefined || redisUrl === '')(
  'distributed Knowledge reindex path',
  () => {
    let app: NestFastifyApplication;
    let token: string;
    const previousEnvironment = new Map<string, string | undefined>();
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
    ];

    beforeAll(async () => {
      for (const key of environmentKeys) previousEnvironment.set(key, process.env[key]);
      process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
      process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
      process.env.HANDSTACK_DEPLOYMENT_PROFILE = 'distributed';
      process.env.HANDSTACK_REDIS_URL = redisUrl;
      process.env.HANDSTACK_ACCESS_TOKEN_SECRET =
        'distributed-reindex-access-secret-at-least-32-characters';
      process.env.HANDSTACK_TOKEN_PEPPER =
        'distributed-reindex-token-pepper-at-least-32-characters';
      process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN = serviceToken;
      process.env.HANDSTACK_WORKER_ORGANIZATION_ID = organizationId;

      app = await createApplication();
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      await app.listen(0, '127.0.0.1');
      process.env.HANDSTACK_API_URL = await app.getUrl();

      const auth = app.get(AuthRuntimeService);
      const administration = new IdentityAdministrationService(auth.storage);
      await administration.createUser(organizationId, {
        id: 'distributed-reindex-admin',
        username: 'distributed.reindex.admin',
        displayName: 'Distributed Reindex Admin',
      });
      const role = await administration.createRole(organizationId, {
        name: 'Knowledge administrator',
      });
      const permission = await administration.createPermission(organizationId, 'knowledge.manage');
      await administration.grantPermission(organizationId, role.id, permission.id);
      await administration.assignRole(organizationId, 'distributed-reindex-admin', role.id);
      await auth.authentication.setPassword(
        organizationId,
        'distributed-reindex-admin',
        'distributed reindex admin password long enough',
      );
      token = (
        await auth.authentication.login(
          organizationId,
          'distributed.reindex.admin',
          'distributed reindex admin password long enough',
        )
      ).accessToken;
    }, 30_000);

    afterAll(async () => {
      await app.close();
      for (const key of environmentKeys) {
        const value = previousEnvironment.get(key);
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    });

    it('enqueues through the authenticated API, runs via Redis worker and publishes on success', async () => {
      const database = app.get(DatabaseService);
      const knowledge = app.get(KnowledgeRuntimeService);
      const models = app.get(ModelAdminRuntimeService);
      const embed = vi.spyOn(models.execution, 'embed').mockImplementation((input) =>
        Promise.resolve({
          vectors: input.input.map(() => (input.model === 'new-embedding' ? [0, 1] : [1, 0])),
          usage: { promptTokens: 1, totalTokens: 1 },
        }),
      );
      const base = await knowledge.createBase(organizationId, {
        name: 'Distributed reindex base',
        description: 'API to Redis worker reindexing',
        chunkSize: 500,
        chunkOverlap: 0,
        strategy: 'PARAGRAPH',
        metadataExtraction: false,
        embeddingModel: 'old-embedding',
      });
      const now = new Date();
      const document = await knowledge.createDocument(organizationId, {
        knowledgeBaseId: base.id,
        sourceType: 'TEXT',
        sourceLocator: 'inline://distributed-reindex',
        title: 'Distributed reindex document',
        contentDigest: 'distributed-reindex-digest',
        sourceId: 'distributed-reindex-source',
        sourceVersion: '1',
        sourceAcl: [{ principalId: '*', permissions: ['read'] }],
        classification: 'INTERNAL',
        residency: 'us-east',
        ingestedAt: now,
        lastVerifiedAt: now,
        retentionPolicy: { retentionDays: 30, legalHold: false },
        deletionStatus: 'ACTIVE',
      });
      await knowledge.ingest(organizationId, document.id, 'vector must be re-embedded');

      const queueName = bullMqQueueName(
        database.config.queue.namespaces.queues,
        organizationId,
        'indexing',
      );
      const connection = redisConnection(database.config.queue.redisUrl ?? '');
      const worker = new Worker<{ payload: unknown }, void>(
        queueName,
        async (job) => {
          const payload = job.data.payload;
          if (typeof payload !== 'object' || payload === null) {
            throw new Error('Invalid indexing payload');
          }
          const apiUrl = process.env.HANDSTACK_API_URL;
          if (apiUrl === undefined) throw new Error('HANDSTACK_API_URL is not configured');
          const response = await fetch(`${apiUrl}/internal/v1/knowledge/reindex-jobs/run`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${serviceToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
          });
          if (!response.ok) throw new Error(`Reindex returned HTTP ${String(response.status)}`);
          await response.arrayBuffer();
          await job.updateProgress({ checkpoint: { status: 'PROCESSED' } });
        },
        { connection, concurrency: 1 },
      );
      try {
        await worker.waitUntilReady();
        const created = await app.inject({
          method: 'POST',
          url: `/api/v1/organizations/${organizationId}/knowledge/reindex-jobs`,
          headers: { authorization: `Bearer ${token}` },
          payload: { knowledgeBaseId: base.id, embeddingModel: 'new-embedding' },
        });
        expect(created.statusCode, created.body).toBe(201);
        const job = created.json<{ id: string; status: string }>();
        expect(job.status).toBe('PENDING');

        const deadline = Date.now() + 15_000;
        let status = 'PENDING';
        while (status === 'PENDING' || status === 'RUNNING') {
          if (Date.now() >= deadline) throw new Error('Distributed reindex did not complete');
          await new Promise((resolve) => setTimeout(resolve, 50));
          const response = await app.inject({
            method: 'GET',
            url: `/api/v1/organizations/${organizationId}/knowledge/reindex-jobs/${job.id}`,
            headers: { authorization: `Bearer ${token}` },
          });
          expect(response.statusCode).toBe(200);
          status = response.json<{ status: string }>().status;
          if (status === 'FAILED') throw new Error(response.json<{ error?: string }>().error);
        }
        expect(status).toBe('SUCCEEDED');
        expect((await knowledge.listBases(organizationId))[0]?.embeddingModel).toBe(
          'new-embedding',
        );
        expect(embed).toHaveBeenCalledTimes(2);
      } finally {
        await worker.close();
        const cleanup = new Queue(queueName, { connection });
        await cleanup.obliterate({ force: true });
        await cleanup.close();
        embed.mockRestore();
      }
      expect(queueName).toBe(`handstack_queues__${organizationId}__indexing`);
    }, 30_000);
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
