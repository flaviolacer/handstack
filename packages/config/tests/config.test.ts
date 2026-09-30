import { describe, expect, it } from 'vitest';
import { configFromEnvironment, defineConfig, resolveConfigLayers } from '../src/index.js';

describe('HandStack configuration', () => {
  it('resolves environment, file, database and organization layers in order', () => {
    const config = resolveConfigLayers(
      { database: { adapter: 'sqlite', url: 'file:env.db' }, server: { apiPort: 3001 } },
      { database: { url: 'file:file.db' }, server: { apiPort: 3002 } },
      { database: { url: 'file:database.db' } },
      { server: { apiPort: 3004 } },
    );
    expect(config.database.url).toBe('file:database.db');
    expect(config.server.apiPort).toBe(3004);
  });
  it('uses compact SQLite defaults and opt-in telemetry', () => {
    expect(defineConfig({})).toMatchObject({
      deployment: { profile: 'compact' },
      database: { adapter: 'sqlite' },
      attachments: { storagePath: '.handstack-data/attachments', maxBytes: 25 * 1024 * 1024 },
      telemetry: { enabled: false },
      logging: { level: 'info' },
      timeouts: { http: 30_000, workflow: 120_000 },
      retention: { conversation: 90, audit: 365 },
      privacy: { storeToolPayloads: false, redactPii: true },
      privacyRetention: { enabled: false, intervalMs: 86_400_000, organizations: [] },
      auditIntegrity: { enabled: false, intervalMs: 86_400_000, organizations: [] },
      security: {},
      knowledgeSync: { enabled: false, intervalMs: 300_000, organizations: [] },
      workflowScheduler: {
        enabled: false,
        intervalMs: 10_000,
        organizations: [],
        principal: 'scheduler',
      },
      worker: {
        concurrency: 1,
        heartbeatIntervalMs: 10_000,
        maxAttempts: 3,
        retryJitterMs: 250,
        metricsPort: 9091,
      },
      rateLimits: {},
    });
  });

  it('accepts the operational settings required by the specification', () => {
    const config = defineConfig({
      timeouts: { provider: 10_000 },
      retention: { conversation: 30 },
      privacy: { storePrompts: false },
      rateLimits: { chat: 60 },
    });
    expect(config).toMatchObject({
      timeouts: { provider: 10_000 },
      retention: { conversation: 30 },
      privacy: { storePrompts: false },
      rateLimits: { chat: 60 },
    });
  });

  it('rejects invalid operational settings instead of accepting unsafe values', () => {
    expect(() => defineConfig({ timeouts: { http: 0 } })).toThrow();
    expect(() => defineConfig({ retention: { audit: -1 } })).toThrow();
    expect(() => defineConfig({ rateLimits: { chat: 0 } })).toThrow();
  });

  it('selects exactly one primary adapter from the environment', () => {
    expect(
      configFromEnvironment({
        HANDSTACK_DATABASE_ADAPTER: 'mongodb',
        HANDSTACK_DATABASE_URL: 'mongodb://localhost/handstack',
      }).database,
    ).toEqual({ adapter: 'mongodb', url: 'mongodb://localhost/handstack' });
  });

  it('rejects unsupported adapters and invalid ports', () => {
    expect(() => configFromEnvironment({ HANDSTACK_DATABASE_ADAPTER: 'oracle' })).toThrow();
    expect(() => configFromEnvironment({ HANDSTACK_API_PORT: 'invalid' })).toThrow('Invalid port');
    expect(() =>
      configFromEnvironment({ HANDSTACK_REDIS_STREAM_PENDING_CLAIM_IDLE_MS: '-1' }),
    ).toThrow('non-negative integer');
  });

  it('accepts an optional distributed Redis URL from the environment', () => {
    expect(
      configFromEnvironment({ HANDSTACK_REDIS_URL: 'redis://localhost:6379/0' }).queue,
    ).toMatchObject({ redisUrl: 'redis://localhost:6379/0', topology: 'standalone' });
  });

  it('requires Redis for distributed deployments and exposes isolated namespaces', () => {
    expect(() => configFromEnvironment({ HANDSTACK_DEPLOYMENT_PROFILE: 'distributed' })).toThrow(
      'requires a Redis URL',
    );
    const distributed = configFromEnvironment({
      HANDSTACK_DEPLOYMENT_PROFILE: 'distributed',
      HANDSTACK_REDIS_URL: 'redis+sentinel://redis-sentinel:26379/0',
    });
    expect(distributed.deployment.profile).toBe('distributed');
    expect(distributed.queue.redisUrl).toBe('redis+sentinel://redis-sentinel:26379/0');
    expect(defineConfig({}).queue.namespaces).toEqual({
      cache: 'handstack:cache',
      rateLimit: 'handstack:rate-limit',
      queues: 'handstack:queues',
      streams: 'handstack:streams',
    });
  });

  it('accepts HTTPS notification endpoints and rejects HTTP', () => {
    expect(
      configFromEnvironment({
        HANDSTACK_NOTIFICATION_SLACK_ENDPOINT: 'https://hooks.example.test/slack',
      }).notifications,
    ).toEqual({ slackEndpoint: 'https://hooks.example.test/slack' });
    expect(() =>
      configFromEnvironment({ HANDSTACK_NOTIFICATION_SLACK_ENDPOINT: 'http://localhost/hook' }),
    ).toThrow('HTTPS');
  });

  it('loads timeout, retention, privacy, namespace and rate-limit settings from the environment', () => {
    const config = configFromEnvironment({
      HANDSTACK_REDIS_NAMESPACE_CACHE: 'tenant-cache',
      HANDSTACK_REDIS_STREAM_PENDING_CLAIM_IDLE_MS: '2500',
      HANDSTACK_REDIS_NAT_MAP: '{"redis-sentinel:26379":{"host":"redis.internal","port":26379}}',
      HANDSTACK_PROVIDER_TIMEOUT_MS: '45000',
      HANDSTACK_VECTOR_STORE_CREDENTIAL_REFERENCE: 'secret://vector-store',
      HANDSTACK_ATTACHMENT_STORAGE_PATH: '.handstack-data/custom-attachments',
      HANDSTACK_ATTACHMENT_MAX_BYTES: '1048576',
      HANDSTACK_WEBHOOK_ALLOWED_HOSTS:
        'hooks.example.test, hooks.example.test,webhooks.example.test',
      HANDSTACK_KNOWLEDGE_ALLOWED_HOSTS: 'docs.example.test, docs.example.test,api.example.test',
      HANDSTACK_LOG_LEVEL: 'warn',
      HANDSTACK_OTLP_ENDPOINT: 'https://otel.example.test:4318',
      HANDSTACK_RETENTION_AUDIT_DAYS: '730',
      HANDSTACK_PRIVACY_STORE_TOOL_PAYLOADS: 'true',
      HANDSTACK_PRIVACY_RETENTION_ENABLED: 'true',
      HANDSTACK_PRIVACY_RETENTION_INTERVAL_MS: '3600000',
      HANDSTACK_PRIVACY_RETENTION_ORGANIZATIONS: 'org-a, org-b,org-a',
      HANDSTACK_PRIVACY_RETENTION_INSTANCE_ID: 'scheduler-a',
      HANDSTACK_AUDIT_INTEGRITY_ENABLED: 'true',
      HANDSTACK_AUDIT_INTEGRITY_INTERVAL_MS: '7200000',
      HANDSTACK_AUDIT_INTEGRITY_ORGANIZATIONS: 'org-audit, org-audit,org-b',
      HANDSTACK_AUDIT_INTEGRITY_INSTANCE_ID: 'audit-a',
      HANDSTACK_KNOWLEDGE_SYNC_ENABLED: 'true',
      HANDSTACK_KNOWLEDGE_SYNC_INTERVAL_MS: '120000',
      HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS: 'org-k, org-k,org-l',
      HANDSTACK_KNOWLEDGE_SYNC_INSTANCE_ID: 'knowledge-a',
      HANDSTACK_WORKFLOW_SCHEDULER_ENABLED: 'true',
      HANDSTACK_WORKFLOW_SCHEDULER_INTERVAL_MS: '5000',
      HANDSTACK_WORKFLOW_SCHEDULER_ORGANIZATIONS: 'org-w',
      HANDSTACK_WORKFLOW_SCHEDULER_INSTANCE_ID: 'workflow-a',
      HANDSTACK_WORKFLOW_SCHEDULER_PRINCIPAL: 'workflow-scheduler',
      HANDSTACK_WORKER_CONCURRENCY: '4',
      HANDSTACK_API_URL: 'https://api.example.test',
      HANDSTACK_ORGANIZATION_ID: 'org-cli',
      HANDSTACK_ACCESS_TOKEN: 'access-token',
      HANDSTACK_PORTABLE_SIGNING_KEY: 'portable-signing-key',
      HANDSTACK_WORKER_ORGANIZATION_ID: 'org-worker',
      HANDSTACK_WORKER_QUEUE: 'agents',
      HANDSTACK_WORKER_HANDLER_MODULE: './handlers.mjs',
      HANDSTACK_WORKER_TIMEOUT_MS: '50000',
      HANDSTACK_WORKER_HEARTBEAT_INTERVAL_MS: '5000',
      HANDSTACK_WORKER_MAX_ATTEMPTS: '5',
      HANDSTACK_WORKER_RETRY_JITTER_MS: '750',
      HANDSTACK_WORKER_METRICS_PORT: '9191',
      HANDSTACK_PLUGIN_CACHE_DIR: '.handstack-data/plugin-cache',
      HANDSTACK_PLUGIN_ISOLATION_REQUIRED: 'true',
      HANDSTACK_PLUGIN_TRUSTED_PUBLISHERS_JSON: '{"publisher-a":"public-key-a"}',
      HANDSTACK_INTERNAL_SERVICE_TOKEN: 'internal-service-token-at-least-32-characters',
      HANDSTACK_INTERNAL_API_KEY: 'internal-api-key',
      HANDSTACK_GATEWAY_KEY_PEPPER: 'gateway-key-pepper',
      HANDSTACK_SCIM_TOKEN_PEPPER: 'scim-token-pepper',
      HANDSTACK_OIDC_STATE_PEPPER: 'oidc-state-pepper',
      HANDSTACK_ACCESS_TOKEN_SECRET: 'access-token-secret',
      HANDSTACK_MASTER_KEY: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      HANDSTACK_TOKEN_PEPPER: 'token-pepper',
      HANDSTACK_ATTACHMENT_SIGNING_SECRET: 'attachment-signing-secret',
      HANDSTACK_WEBHOOK_MASTER_KEY: 'webhook-legacy-master-key',
      HANDSTACK_RATE_LIMITS_JSON: '{"chat":120}',
    });
    expect(config).toMatchObject({
      queue: {
        namespaces: { cache: 'tenant-cache' },
        pendingClaimIdleMs: 2500,
        natMap: { 'redis-sentinel:26379': { host: 'redis.internal', port: 26379 } },
      },
      timeouts: { provider: 45_000 },
      vectorStore: { credentialReference: 'secret://vector-store' },
      attachments: {
        storagePath: '.handstack-data/custom-attachments',
        maxBytes: 1_048_576,
      },
      webhooks: { allowedHosts: ['hooks.example.test', 'webhooks.example.test'] },
      knowledge: { allowedHosts: ['docs.example.test', 'api.example.test'] },
      plugins: {
        cacheDir: '.handstack-data/plugin-cache',
        isolationRequired: true,
        trustedPublishers: { 'publisher-a': 'public-key-a' },
      },
      security: {
        masterKey: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
        internalServiceToken: 'internal-service-token-at-least-32-characters',
        internalApiKey: 'internal-api-key',
        gatewayKeyPepper: 'gateway-key-pepper',
        scimTokenPepper: 'scim-token-pepper',
        oidcStatePepper: 'oidc-state-pepper',
        accessTokenSecret: 'access-token-secret',
        tokenPepper: 'token-pepper',
        attachmentSigningSecret: 'attachment-signing-secret',
        webhookLegacyMasterKey: 'webhook-legacy-master-key',
      },
      cli: {
        apiUrl: 'https://api.example.test',
        organizationId: 'org-cli',
        accessToken: 'access-token',
        portableSigningKey: 'portable-signing-key',
      },
      logging: { level: 'warn' },
      telemetry: { otlpEndpoint: 'https://otel.example.test:4318' },
      retention: { audit: 730 },
      privacy: { storeToolPayloads: true },
      privacyRetention: {
        enabled: true,
        intervalMs: 3_600_000,
        organizations: ['org-a', 'org-b'],
        instanceId: 'scheduler-a',
      },
      auditIntegrity: {
        enabled: true,
        intervalMs: 7_200_000,
        organizations: ['org-audit', 'org-b'],
        instanceId: 'audit-a',
      },
      knowledgeSync: {
        enabled: true,
        intervalMs: 120_000,
        organizations: ['org-k', 'org-l'],
        instanceId: 'knowledge-a',
      },
      workflowScheduler: {
        enabled: true,
        intervalMs: 5_000,
        organizations: ['org-w'],
        instanceId: 'workflow-a',
        principal: 'workflow-scheduler',
      },
      worker: {
        apiUrl: 'https://api.example.test',
        organizationId: 'org-worker',
        queue: 'agents',
        handlerModule: './handlers.mjs',
        concurrency: 4,
        timeoutMs: 50_000,
        heartbeatIntervalMs: 5_000,
        maxAttempts: 5,
        retryJitterMs: 750,
        metricsPort: 9191,
      },
      rateLimits: { chat: 120 },
    });
  });

  it('rejects an unsafe privacy retention interval', () => {
    expect(() =>
      configFromEnvironment({ HANDSTACK_PRIVACY_RETENTION_INTERVAL_MS: '59999' }),
    ).toThrow();
  });

  it('rejects an unsafe audit integrity interval', () => {
    expect(() =>
      configFromEnvironment({ HANDSTACK_AUDIT_INTEGRITY_INTERVAL_MS: '59999' }),
    ).toThrow();
  });

  it('loads tenant-safe SMTP configuration without accepting credentials inline', () => {
    expect(
      configFromEnvironment({
        HANDSTACK_SMTP_HOST: 'smtp.example.test',
        HANDSTACK_SMTP_PORT: '465',
        HANDSTACK_SMTP_SECURE: 'true',
        HANDSTACK_SMTP_USERNAME: 'mailer',
        HANDSTACK_SMTP_PASSWORD_REF: 'secret://smtp-password',
        HANDSTACK_SMTP_FROM: 'noreply@example.test',
      }).notifications.smtp,
    ).toEqual({
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      username: 'mailer',
      passwordRef: 'secret://smtp-password',
      from: 'noreply@example.test',
    });
    expect(() =>
      defineConfig({
        notifications: {
          smtp: {
            host: 'smtp.example.test',
            username: 'mailer',
            passwordRef: '',
            from: 'noreply@example.test',
          },
        },
      }),
    ).toThrow();
  });

  it('rejects a URL whose scheme does not match the selected adapter', () => {
    expect(() =>
      defineConfig({ database: { adapter: 'mongodb', url: 'file:./handstack.db' } }),
    ).toThrow('incompatible');
    expect(() =>
      defineConfig({ database: { adapter: 'sqlite', url: 'postgresql://localhost/handstack' } }),
    ).toThrow('incompatible');
  });
});
