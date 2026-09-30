import { z } from 'zod';

export const databaseAdapterSchema = z.enum([
  'postgresql',
  'mysql',
  'mariadb',
  'sqlite',
  'sqlserver',
  'mongodb',
]);

export const deploymentProfileSchema = z.enum(['compact', 'distributed']);
export const redisTopologySchema = z.enum(['standalone', 'sentinel', 'cluster']);
export const logLevelSchema = z.enum([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
]);
const redisNatMapSchema = z.record(
  z.string().trim().min(1),
  z.object({ host: z.string().trim().min(1), port: z.number().int().min(1).max(65_535) }).strict(),
);
export const vectorStoreAdapterSchema = z.enum([
  'repository',
  'pgvector',
  'mongodb-atlas',
  'qdrant',
  'pinecone',
  'weaviate',
  'chroma',
]);

const timeoutMsSchema = z.number().int().min(1).max(86_400_000);
const retentionDaysSchema = z.number().int().min(0).max(36_500);

export const handStackConfigSchema = z
  .object({
    deployment: z
      .object({
        profile: deploymentProfileSchema.default('compact'),
      })
      .strict()
      .default({ profile: 'compact' }),
    database: z
      .object({
        adapter: databaseAdapterSchema.default('sqlite'),
        url: z.string().min(1).default('file:./handstack.db'),
      })
      .strict()
      .default({ adapter: 'sqlite', url: 'file:./handstack.db' }),
    queue: z
      .object({
        redisUrl: z.url().optional(),
        topology: redisTopologySchema.default('standalone'),
        natMap: redisNatMapSchema.default({}),
        pendingClaimIdleMs: z.number().int().min(0).max(86_400_000).default(30_000),
        namespaces: z
          .object({
            cache: z.string().trim().min(1).default('handstack:cache'),
            rateLimit: z.string().trim().min(1).default('handstack:rate-limit'),
            queues: z.string().trim().min(1).default('handstack:queues'),
            streams: z.string().trim().min(1).default('handstack:streams'),
          })
          .strict()
          .default({
            cache: 'handstack:cache',
            rateLimit: 'handstack:rate-limit',
            queues: 'handstack:queues',
            streams: 'handstack:streams',
          }),
      })
      .strict()
      .default({
        topology: 'standalone',
        natMap: {},
        pendingClaimIdleMs: 30_000,
        namespaces: {
          cache: 'handstack:cache',
          rateLimit: 'handstack:rate-limit',
          queues: 'handstack:queues',
          streams: 'handstack:streams',
        },
      }),
    vectorStore: z
      .object({
        adapter: vectorStoreAdapterSchema.default('repository'),
        endpoint: z.url().optional(),
        collection: z.string().trim().min(1).optional(),
        index: z.string().trim().min(1).optional(),
        credentialReference: z.string().trim().min(1).optional(),
      })
      .strict()
      .default({ adapter: 'repository' }),
    notifications: z
      .object({
        smtp: z
          .object({
            host: z.string().trim().min(1),
            port: z.number().int().min(1).max(65_535).default(587),
            secure: z.boolean().default(false),
            username: z.string().trim().min(1),
            passwordRef: z.string().trim().min(1),
            from: z.email(),
          })
          .strict()
          .optional(),
        webhookEndpoint: z
          .url()
          .refine((value) => value.startsWith('https://'), 'Notification endpoint must use HTTPS')
          .optional(),
        slackEndpoint: z
          .url()
          .refine((value) => value.startsWith('https://'), 'Notification endpoint must use HTTPS')
          .optional(),
        teamsEndpoint: z
          .url()
          .refine((value) => value.startsWith('https://'), 'Notification endpoint must use HTTPS')
          .optional(),
        discordEndpoint: z
          .url()
          .refine((value) => value.startsWith('https://'), 'Notification endpoint must use HTTPS')
          .optional(),
      })
      .strict()
      .default({}),
    webhooks: z
      .object({
        allowedHosts: z.array(z.string().trim().min(1)).default([]),
      })
      .strict()
      .default({ allowedHosts: [] }),
    knowledge: z
      .object({
        allowedHosts: z.array(z.string().trim().min(1)).default([]),
      })
      .strict()
      .default({ allowedHosts: [] }),
    plugins: z
      .object({
        cacheDir: z.string().trim().min(1).optional(),
        isolationRequired: z.boolean().default(false),
        trustedPublishers: z.record(z.string().trim().min(1), z.string().trim().min(1)).default({}),
      })
      .strict()
      .default({ isolationRequired: false, trustedPublishers: {} }),
    security: z
      .object({
        masterKey: z.string().trim().min(1).optional(),
        internalServiceToken: z.string().trim().min(32).optional(),
        internalApiKey: z.string().trim().min(1).optional(),
        gatewayKeyPepper: z.string().trim().min(1).optional(),
        scimTokenPepper: z.string().trim().min(1).optional(),
        oidcStatePepper: z.string().trim().min(1).optional(),
        accessTokenSecret: z.string().trim().min(1).optional(),
        tokenPepper: z.string().trim().min(1).optional(),
        attachmentSigningSecret: z.string().trim().min(1).optional(),
        webhookLegacyMasterKey: z.string().trim().min(1).optional(),
      })
      .strict()
      .default({}),
    cli: z
      .object({
        apiUrl: z.url().optional(),
        organizationId: z.string().trim().min(1).optional(),
        accessToken: z.string().trim().min(1).optional(),
        portableSigningKey: z.string().trim().min(1).optional(),
      })
      .strict()
      .default({}),
    server: z
      .object({
        apiPort: z.number().int().min(1).max(65_535).default(3001),
        webPort: z.number().int().min(1).max(65_535).default(3000),
      })
      .strict()
      .default({ apiPort: 3001, webPort: 3000 }),
    attachments: z
      .object({
        storagePath: z.string().trim().min(1).default('.handstack-data/attachments'),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(1_073_741_824)
          .default(25 * 1024 * 1024),
      })
      .strict()
      .default({ storagePath: '.handstack-data/attachments', maxBytes: 25 * 1024 * 1024 }),
    telemetry: z
      .object({ enabled: z.boolean().default(false), otlpEndpoint: z.url().optional() })
      .strict()
      .default({ enabled: false }),
    logging: z
      .object({ level: logLevelSchema.default('info') })
      .strict()
      .default({ level: 'info' }),
    timeouts: z
      .object({
        http: timeoutMsSchema.default(30_000),
        provider: timeoutMsSchema.default(30_000),
        tool: timeoutMsSchema.default(30_000),
        mcp: timeoutMsSchema.default(30_000),
        agent: timeoutMsSchema.default(120_000),
        workflow: timeoutMsSchema.default(120_000),
      })
      .strict()
      .default({
        http: 30_000,
        provider: 30_000,
        tool: 30_000,
        mcp: 30_000,
        agent: 120_000,
        workflow: 120_000,
      }),
    retention: z
      .object({
        conversation: retentionDaysSchema.default(90),
        audit: retentionDaysSchema.default(365),
        usage: retentionDaysSchema.default(365),
        trace: retentionDaysSchema.default(30),
        attachments: retentionDaysSchema.default(30),
      })
      .strict()
      .default({
        conversation: 90,
        audit: 365,
        usage: 365,
        trace: 30,
        attachments: 30,
      }),
    privacy: z
      .object({
        storePrompts: z.boolean().default(true),
        storeResponses: z.boolean().default(true),
        storeToolPayloads: z.boolean().default(false),
        redactPii: z.boolean().default(true),
        sendTelemetry: z.boolean().default(false),
      })
      .strict()
      .default({
        storePrompts: true,
        storeResponses: true,
        storeToolPayloads: false,
        redactPii: true,
        sendTelemetry: false,
      }),
    privacyRetention: z
      .object({
        enabled: z.boolean().default(false),
        intervalMs: z.number().int().min(60_000).max(31_536_000_000).default(86_400_000),
        organizations: z.array(z.string().trim().min(1)).default([]),
        instanceId: z.string().trim().min(1).optional(),
      })
      .strict()
      .default({ enabled: false, intervalMs: 86_400_000, organizations: [] }),
    auditIntegrity: z
      .object({
        enabled: z.boolean().default(false),
        intervalMs: z.number().int().min(60_000).max(31_536_000_000).default(86_400_000),
        organizations: z.array(z.string().trim().min(1)).default([]),
        instanceId: z.string().trim().min(1).optional(),
      })
      .strict()
      .default({ enabled: false, intervalMs: 86_400_000, organizations: [] }),
    knowledgeSync: z
      .object({
        enabled: z.boolean().default(false),
        intervalMs: z.number().int().min(1_000).max(31_536_000_000).default(300_000),
        organizations: z.array(z.string().trim().min(1)).default([]),
        instanceId: z.string().trim().min(1).optional(),
      })
      .strict()
      .default({ enabled: false, intervalMs: 300_000, organizations: [] }),
    workflowScheduler: z
      .object({
        enabled: z.boolean().default(false),
        intervalMs: z.number().int().min(1_000).max(31_536_000_000).default(10_000),
        organizations: z.array(z.string().trim().min(1)).default([]),
        instanceId: z.string().trim().min(1).optional(),
        principal: z.string().trim().min(1).default('scheduler'),
      })
      .strict()
      .default({ enabled: false, intervalMs: 10_000, organizations: [], principal: 'scheduler' }),
    worker: z
      .object({
        apiUrl: z.url().optional(),
        organizationId: z.string().trim().min(1).optional(),
        queue: z.string().trim().min(1).optional(),
        handlerModule: z.string().trim().min(1).optional(),
        concurrency: z.number().int().min(1).default(1),
        timeoutMs: timeoutMsSchema.optional(),
        heartbeatIntervalMs: z.number().int().min(1).max(86_400_000).default(10_000),
        maxAttempts: z.number().int().min(1).max(100).default(3),
        retryJitterMs: z.number().int().min(1).max(86_400_000).default(250),
        metricsPort: z.number().int().min(1).max(65_535).default(9091),
      })
      .strict()
      .default({
        concurrency: 1,
        heartbeatIntervalMs: 10_000,
        maxAttempts: 3,
        retryJitterMs: 250,
        metricsPort: 9091,
      }),
    rateLimits: z
      .record(z.string().trim().min(1), z.number().int().min(1).max(1_000_000))
      .default({}),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.deployment.profile === 'distributed' && config.queue.redisUrl === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['queue', 'redisUrl'],
        message: 'Distributed deployment requires a Redis URL',
      });
    }
    const schemes: Record<(typeof config.database)['adapter'], readonly string[]> = {
      sqlite: ['file:'],
      postgresql: ['postgres://', 'postgresql://'],
      mongodb: ['mongodb://', 'mongodb+srv://'],
      mysql: ['mysql://'],
      mariadb: ['mariadb://', 'mysql://'],
      sqlserver: ['sqlserver://', 'mssql://'],
    };
    if (
      !schemes[config.database.adapter].some((scheme) => config.database.url.startsWith(scheme))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['database', 'url'],
        message: `Database URL is incompatible with adapter ${config.database.adapter}`,
      });
    }
  });

export type HandStackConfig = z.infer<typeof handStackConfigSchema>;

export type HandStackConfigLayer = z.input<typeof handStackConfigSchema>;

/** Resolves configuration in the specification's precedence order. */
export function resolveConfigLayers(
  environment: HandStackConfigLayer,
  configFile: HandStackConfigLayer = {},
  databaseSettings: HandStackConfigLayer = {},
  organizationSettings: HandStackConfigLayer = {},
): HandStackConfig {
  return defineConfig(
    mergeConfigLayers(environment, configFile, databaseSettings, organizationSettings),
  );
}

export function defineConfig(config: z.input<typeof handStackConfigSchema>): HandStackConfig {
  return handStackConfigSchema.parse(config);
}

function mergeConfigLayers(...layers: readonly HandStackConfigLayer[]): HandStackConfigLayer {
  const result: Record<string, unknown> = {};
  for (const layer of layers) mergeRecord(result, layer);
  return result;
}

function mergeRecord(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(target[key]) && isRecord(value)) mergeRecord(target[key], value);
    else if (value !== undefined) target[key] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function configFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): HandStackConfig {
  return defineConfig(configLayerFromEnvironment(environment));
}

export function configLayerFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): HandStackConfigLayer {
  return {
    deployment: {
      profile: deploymentProfileSchema.parse(environment.HANDSTACK_DEPLOYMENT_PROFILE ?? 'compact'),
    },
    database: {
      adapter: databaseAdapterSchema.parse(environment.HANDSTACK_DATABASE_ADAPTER ?? 'sqlite'),
      url: environment.HANDSTACK_DATABASE_URL ?? 'file:./handstack.db',
    },
    queue: {
      ...(environment.HANDSTACK_REDIS_URL === undefined
        ? {}
        : { redisUrl: environment.HANDSTACK_REDIS_URL }),
      topology: redisTopologySchema.parse(environment.HANDSTACK_REDIS_TOPOLOGY ?? 'standalone'),
      natMap: parseRedisNatMap(environment.HANDSTACK_REDIS_NAT_MAP),
      pendingClaimIdleMs: parseNonNegativeInteger(
        environment.HANDSTACK_REDIS_STREAM_PENDING_CLAIM_IDLE_MS,
        30_000,
      ),
      namespaces: {
        ...(environment.HANDSTACK_REDIS_NAMESPACE_CACHE === undefined
          ? {}
          : { cache: environment.HANDSTACK_REDIS_NAMESPACE_CACHE }),
        ...(environment.HANDSTACK_REDIS_NAMESPACE_RATE_LIMIT === undefined
          ? {}
          : { rateLimit: environment.HANDSTACK_REDIS_NAMESPACE_RATE_LIMIT }),
        ...(environment.HANDSTACK_REDIS_NAMESPACE_QUEUES === undefined
          ? {}
          : { queues: environment.HANDSTACK_REDIS_NAMESPACE_QUEUES }),
        ...(environment.HANDSTACK_REDIS_NAMESPACE_STREAMS === undefined
          ? {}
          : { streams: environment.HANDSTACK_REDIS_NAMESPACE_STREAMS }),
      },
    },
    vectorStore: {
      adapter: vectorStoreAdapterSchema.parse(
        environment.HANDSTACK_VECTOR_STORE_ADAPTER ?? 'repository',
      ),
      ...(environment.HANDSTACK_VECTOR_STORE_ENDPOINT === undefined
        ? {}
        : { endpoint: environment.HANDSTACK_VECTOR_STORE_ENDPOINT }),
      ...(environment.HANDSTACK_VECTOR_STORE_COLLECTION === undefined
        ? {}
        : { collection: environment.HANDSTACK_VECTOR_STORE_COLLECTION }),
      ...(environment.HANDSTACK_VECTOR_STORE_INDEX === undefined
        ? {}
        : { index: environment.HANDSTACK_VECTOR_STORE_INDEX }),
      ...(environment.HANDSTACK_VECTOR_STORE_CREDENTIAL_REFERENCE === undefined
        ? {}
        : { credentialReference: environment.HANDSTACK_VECTOR_STORE_CREDENTIAL_REFERENCE }),
    },
    notifications: {
      ...(environment.HANDSTACK_SMTP_HOST === undefined
        ? {}
        : {
            smtp: {
              host: environment.HANDSTACK_SMTP_HOST,
              port: parsePort(environment.HANDSTACK_SMTP_PORT, 587),
              secure: environment.HANDSTACK_SMTP_SECURE === 'true',
              username: environment.HANDSTACK_SMTP_USERNAME ?? '',
              passwordRef: environment.HANDSTACK_SMTP_PASSWORD_REF ?? '',
              from: environment.HANDSTACK_SMTP_FROM ?? '',
            },
          }),
      ...(environment.HANDSTACK_NOTIFICATION_SLACK_ENDPOINT === undefined
        ? {}
        : { slackEndpoint: environment.HANDSTACK_NOTIFICATION_SLACK_ENDPOINT }),
      ...(environment.HANDSTACK_NOTIFICATION_WEBHOOK_ENDPOINT === undefined
        ? {}
        : { webhookEndpoint: environment.HANDSTACK_NOTIFICATION_WEBHOOK_ENDPOINT }),
      ...(environment.HANDSTACK_NOTIFICATION_TEAMS_ENDPOINT === undefined
        ? {}
        : { teamsEndpoint: environment.HANDSTACK_NOTIFICATION_TEAMS_ENDPOINT }),
      ...(environment.HANDSTACK_NOTIFICATION_DISCORD_ENDPOINT === undefined
        ? {}
        : { discordEndpoint: environment.HANDSTACK_NOTIFICATION_DISCORD_ENDPOINT }),
    },
    webhooks: {
      ...(environment.HANDSTACK_WEBHOOK_ALLOWED_HOSTS === undefined
        ? {}
        : { allowedHosts: parseCsv(environment.HANDSTACK_WEBHOOK_ALLOWED_HOSTS) }),
    },
    knowledge: {
      ...(environment.HANDSTACK_KNOWLEDGE_ALLOWED_HOSTS === undefined
        ? {}
        : { allowedHosts: parseCsv(environment.HANDSTACK_KNOWLEDGE_ALLOWED_HOSTS) }),
    },
    plugins: {
      ...(environment.HANDSTACK_PLUGIN_CACHE_DIR === undefined
        ? {}
        : { cacheDir: environment.HANDSTACK_PLUGIN_CACHE_DIR }),
      ...(optionalBoolean(environment.HANDSTACK_PLUGIN_ISOLATION_REQUIRED) === undefined
        ? {}
        : {
            isolationRequired: optionalBoolean(environment.HANDSTACK_PLUGIN_ISOLATION_REQUIRED),
          }),
      ...(environment.HANDSTACK_PLUGIN_TRUSTED_PUBLISHERS_JSON === undefined
        ? {}
        : {
            trustedPublishers: parseTrustedPublishers(
              environment.HANDSTACK_PLUGIN_TRUSTED_PUBLISHERS_JSON,
            ),
          }),
    },
    security: {
      ...(environment.HANDSTACK_MASTER_KEY === undefined
        ? {}
        : { masterKey: environment.HANDSTACK_MASTER_KEY }),
      ...(environment.HANDSTACK_INTERNAL_SERVICE_TOKEN === undefined
        ? {}
        : { internalServiceToken: environment.HANDSTACK_INTERNAL_SERVICE_TOKEN }),
      ...(environment.HANDSTACK_INTERNAL_API_KEY === undefined
        ? {}
        : { internalApiKey: environment.HANDSTACK_INTERNAL_API_KEY }),
      ...(environment.HANDSTACK_GATEWAY_KEY_PEPPER === undefined
        ? {}
        : { gatewayKeyPepper: environment.HANDSTACK_GATEWAY_KEY_PEPPER }),
      ...(environment.HANDSTACK_SCIM_TOKEN_PEPPER === undefined
        ? {}
        : { scimTokenPepper: environment.HANDSTACK_SCIM_TOKEN_PEPPER }),
      ...(environment.HANDSTACK_OIDC_STATE_PEPPER === undefined
        ? {}
        : { oidcStatePepper: environment.HANDSTACK_OIDC_STATE_PEPPER }),
      ...(environment.HANDSTACK_ACCESS_TOKEN_SECRET === undefined
        ? {}
        : { accessTokenSecret: environment.HANDSTACK_ACCESS_TOKEN_SECRET }),
      ...(environment.HANDSTACK_TOKEN_PEPPER === undefined
        ? {}
        : { tokenPepper: environment.HANDSTACK_TOKEN_PEPPER }),
      ...(environment.HANDSTACK_ATTACHMENT_SIGNING_SECRET === undefined
        ? {}
        : { attachmentSigningSecret: environment.HANDSTACK_ATTACHMENT_SIGNING_SECRET }),
      ...(environment.HANDSTACK_WEBHOOK_MASTER_KEY === undefined
        ? {}
        : { webhookLegacyMasterKey: environment.HANDSTACK_WEBHOOK_MASTER_KEY }),
    },
    cli: {
      ...(environment.HANDSTACK_API_URL === undefined
        ? {}
        : { apiUrl: environment.HANDSTACK_API_URL }),
      ...(environment.HANDSTACK_ORGANIZATION_ID === undefined
        ? {}
        : { organizationId: environment.HANDSTACK_ORGANIZATION_ID }),
      ...(environment.HANDSTACK_ACCESS_TOKEN === undefined
        ? {}
        : { accessToken: environment.HANDSTACK_ACCESS_TOKEN }),
      ...(environment.HANDSTACK_PORTABLE_SIGNING_KEY === undefined
        ? {}
        : { portableSigningKey: environment.HANDSTACK_PORTABLE_SIGNING_KEY }),
    },
    server: {
      apiPort: parsePort(environment.HANDSTACK_API_PORT, 3001),
      webPort: parsePort(environment.HANDSTACK_WEB_PORT, 3000),
    },
    attachments: {
      ...(environment.HANDSTACK_ATTACHMENT_STORAGE_PATH === undefined
        ? {}
        : { storagePath: environment.HANDSTACK_ATTACHMENT_STORAGE_PATH }),
      ...(optionalInteger(environment.HANDSTACK_ATTACHMENT_MAX_BYTES) === undefined
        ? {}
        : { maxBytes: optionalInteger(environment.HANDSTACK_ATTACHMENT_MAX_BYTES) }),
    },
    telemetry: {
      enabled: environment.HANDSTACK_TELEMETRY_ENABLED === 'true',
      ...(environment.HANDSTACK_OTLP_ENDPOINT === undefined
        ? {}
        : { otlpEndpoint: environment.HANDSTACK_OTLP_ENDPOINT }),
    },
    logging: {
      level: logLevelSchema.parse(environment.HANDSTACK_LOG_LEVEL ?? 'info'),
    },
    timeouts: {
      ...(optionalInteger(environment.HANDSTACK_HTTP_TIMEOUT_MS) === undefined
        ? {}
        : { http: optionalInteger(environment.HANDSTACK_HTTP_TIMEOUT_MS) }),
      ...(optionalInteger(environment.HANDSTACK_PROVIDER_TIMEOUT_MS) === undefined
        ? {}
        : { provider: optionalInteger(environment.HANDSTACK_PROVIDER_TIMEOUT_MS) }),
      ...(optionalInteger(environment.HANDSTACK_TOOL_TIMEOUT_MS) === undefined
        ? {}
        : { tool: optionalInteger(environment.HANDSTACK_TOOL_TIMEOUT_MS) }),
      ...(optionalInteger(environment.HANDSTACK_MCP_TIMEOUT_MS) === undefined
        ? {}
        : { mcp: optionalInteger(environment.HANDSTACK_MCP_TIMEOUT_MS) }),
      ...(optionalInteger(environment.HANDSTACK_AGENT_TIMEOUT_MS) === undefined
        ? {}
        : { agent: optionalInteger(environment.HANDSTACK_AGENT_TIMEOUT_MS) }),
      ...(optionalInteger(environment.HANDSTACK_WORKFLOW_TIMEOUT_MS) === undefined
        ? {}
        : { workflow: optionalInteger(environment.HANDSTACK_WORKFLOW_TIMEOUT_MS) }),
    },
    retention: {
      ...(optionalInteger(environment.HANDSTACK_RETENTION_CONVERSATION_DAYS) === undefined
        ? {}
        : { conversation: optionalInteger(environment.HANDSTACK_RETENTION_CONVERSATION_DAYS) }),
      ...(optionalInteger(environment.HANDSTACK_RETENTION_AUDIT_DAYS) === undefined
        ? {}
        : { audit: optionalInteger(environment.HANDSTACK_RETENTION_AUDIT_DAYS) }),
      ...(optionalInteger(environment.HANDSTACK_RETENTION_USAGE_DAYS) === undefined
        ? {}
        : { usage: optionalInteger(environment.HANDSTACK_RETENTION_USAGE_DAYS) }),
      ...(optionalInteger(environment.HANDSTACK_RETENTION_TRACE_DAYS) === undefined
        ? {}
        : { trace: optionalInteger(environment.HANDSTACK_RETENTION_TRACE_DAYS) }),
      ...(optionalInteger(environment.HANDSTACK_RETENTION_ATTACHMENTS_DAYS) === undefined
        ? {}
        : { attachments: optionalInteger(environment.HANDSTACK_RETENTION_ATTACHMENTS_DAYS) }),
    },
    privacy: {
      ...(optionalBoolean(environment.HANDSTACK_PRIVACY_STORE_PROMPTS) === undefined
        ? {}
        : { storePrompts: optionalBoolean(environment.HANDSTACK_PRIVACY_STORE_PROMPTS) }),
      ...(optionalBoolean(environment.HANDSTACK_PRIVACY_STORE_RESPONSES) === undefined
        ? {}
        : { storeResponses: optionalBoolean(environment.HANDSTACK_PRIVACY_STORE_RESPONSES) }),
      ...(optionalBoolean(environment.HANDSTACK_PRIVACY_STORE_TOOL_PAYLOADS) === undefined
        ? {}
        : {
            storeToolPayloads: optionalBoolean(environment.HANDSTACK_PRIVACY_STORE_TOOL_PAYLOADS),
          }),
      ...(optionalBoolean(environment.HANDSTACK_PRIVACY_REDACT_PII) === undefined
        ? {}
        : { redactPii: optionalBoolean(environment.HANDSTACK_PRIVACY_REDACT_PII) }),
      ...(optionalBoolean(environment.HANDSTACK_PRIVACY_SEND_TELEMETRY) === undefined
        ? {}
        : { sendTelemetry: optionalBoolean(environment.HANDSTACK_PRIVACY_SEND_TELEMETRY) }),
    },
    privacyRetention: {
      ...(optionalBoolean(environment.HANDSTACK_PRIVACY_RETENTION_ENABLED) === undefined
        ? {}
        : { enabled: optionalBoolean(environment.HANDSTACK_PRIVACY_RETENTION_ENABLED) }),
      ...(optionalInteger(environment.HANDSTACK_PRIVACY_RETENTION_INTERVAL_MS) === undefined
        ? {}
        : { intervalMs: optionalInteger(environment.HANDSTACK_PRIVACY_RETENTION_INTERVAL_MS) }),
      ...(environment.HANDSTACK_PRIVACY_RETENTION_ORGANIZATIONS === undefined
        ? {}
        : {
            organizations: parseCsv(environment.HANDSTACK_PRIVACY_RETENTION_ORGANIZATIONS),
          }),
      ...(environment.HANDSTACK_PRIVACY_RETENTION_INSTANCE_ID === undefined
        ? {}
        : { instanceId: environment.HANDSTACK_PRIVACY_RETENTION_INSTANCE_ID }),
    },
    auditIntegrity: {
      ...(optionalBoolean(environment.HANDSTACK_AUDIT_INTEGRITY_ENABLED) === undefined
        ? {}
        : { enabled: optionalBoolean(environment.HANDSTACK_AUDIT_INTEGRITY_ENABLED) }),
      ...(optionalInteger(environment.HANDSTACK_AUDIT_INTEGRITY_INTERVAL_MS) === undefined
        ? {}
        : { intervalMs: optionalInteger(environment.HANDSTACK_AUDIT_INTEGRITY_INTERVAL_MS) }),
      ...(environment.HANDSTACK_AUDIT_INTEGRITY_ORGANIZATIONS === undefined
        ? {}
        : { organizations: parseCsv(environment.HANDSTACK_AUDIT_INTEGRITY_ORGANIZATIONS) }),
      ...(environment.HANDSTACK_AUDIT_INTEGRITY_INSTANCE_ID === undefined
        ? {}
        : { instanceId: environment.HANDSTACK_AUDIT_INTEGRITY_INSTANCE_ID }),
    },
    knowledgeSync: {
      ...(optionalBoolean(environment.HANDSTACK_KNOWLEDGE_SYNC_ENABLED) === undefined
        ? {}
        : { enabled: optionalBoolean(environment.HANDSTACK_KNOWLEDGE_SYNC_ENABLED) }),
      ...(optionalInteger(environment.HANDSTACK_KNOWLEDGE_SYNC_INTERVAL_MS) === undefined
        ? {}
        : { intervalMs: optionalInteger(environment.HANDSTACK_KNOWLEDGE_SYNC_INTERVAL_MS) }),
      ...(environment.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS === undefined
        ? {}
        : { organizations: parseCsv(environment.HANDSTACK_KNOWLEDGE_SYNC_ORGANIZATIONS) }),
      ...(environment.HANDSTACK_KNOWLEDGE_SYNC_INSTANCE_ID === undefined
        ? {}
        : { instanceId: environment.HANDSTACK_KNOWLEDGE_SYNC_INSTANCE_ID }),
    },
    workflowScheduler: {
      ...(optionalBoolean(environment.HANDSTACK_WORKFLOW_SCHEDULER_ENABLED) === undefined
        ? {}
        : { enabled: optionalBoolean(environment.HANDSTACK_WORKFLOW_SCHEDULER_ENABLED) }),
      ...(optionalInteger(environment.HANDSTACK_WORKFLOW_SCHEDULER_INTERVAL_MS) === undefined
        ? {}
        : { intervalMs: optionalInteger(environment.HANDSTACK_WORKFLOW_SCHEDULER_INTERVAL_MS) }),
      ...(environment.HANDSTACK_WORKFLOW_SCHEDULER_ORGANIZATIONS === undefined
        ? {}
        : {
            organizations: parseCsv(environment.HANDSTACK_WORKFLOW_SCHEDULER_ORGANIZATIONS),
          }),
      ...(environment.HANDSTACK_WORKFLOW_SCHEDULER_INSTANCE_ID === undefined
        ? {}
        : { instanceId: environment.HANDSTACK_WORKFLOW_SCHEDULER_INSTANCE_ID }),
      ...(environment.HANDSTACK_WORKFLOW_SCHEDULER_PRINCIPAL === undefined
        ? {}
        : { principal: environment.HANDSTACK_WORKFLOW_SCHEDULER_PRINCIPAL }),
    },
    worker: {
      ...(environment.HANDSTACK_API_URL === undefined
        ? {}
        : { apiUrl: environment.HANDSTACK_API_URL }),
      ...(environment.HANDSTACK_WORKER_ORGANIZATION_ID === undefined
        ? {}
        : { organizationId: environment.HANDSTACK_WORKER_ORGANIZATION_ID }),
      ...(environment.HANDSTACK_WORKER_QUEUE === undefined
        ? {}
        : { queue: environment.HANDSTACK_WORKER_QUEUE }),
      ...(environment.HANDSTACK_WORKER_HANDLER_MODULE === undefined
        ? {}
        : { handlerModule: environment.HANDSTACK_WORKER_HANDLER_MODULE }),
      ...(optionalInteger(environment.HANDSTACK_WORKER_CONCURRENCY) === undefined
        ? {}
        : { concurrency: optionalInteger(environment.HANDSTACK_WORKER_CONCURRENCY) }),
      ...(optionalInteger(environment.HANDSTACK_WORKER_TIMEOUT_MS) === undefined
        ? {}
        : { timeoutMs: optionalInteger(environment.HANDSTACK_WORKER_TIMEOUT_MS) }),
      ...(optionalInteger(environment.HANDSTACK_WORKER_HEARTBEAT_INTERVAL_MS) === undefined
        ? {}
        : {
            heartbeatIntervalMs: optionalInteger(
              environment.HANDSTACK_WORKER_HEARTBEAT_INTERVAL_MS,
            ),
          }),
      ...(optionalInteger(environment.HANDSTACK_WORKER_MAX_ATTEMPTS) === undefined
        ? {}
        : { maxAttempts: optionalInteger(environment.HANDSTACK_WORKER_MAX_ATTEMPTS) }),
      ...(optionalInteger(environment.HANDSTACK_WORKER_RETRY_JITTER_MS) === undefined
        ? {}
        : { retryJitterMs: optionalInteger(environment.HANDSTACK_WORKER_RETRY_JITTER_MS) }),
      ...(optionalInteger(environment.HANDSTACK_WORKER_METRICS_PORT) === undefined
        ? {}
        : { metricsPort: optionalInteger(environment.HANDSTACK_WORKER_METRICS_PORT) }),
    },
    ...(environment.HANDSTACK_RATE_LIMITS_JSON === undefined
      ? {}
      : { rateLimits: parseRateLimits(environment.HANDSTACK_RATE_LIMITS_JSON) }),
  };
}

function optionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid integer: ${value}`);
  return parsed;
}

function optionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid boolean: ${value}`);
}

function parseRateLimits(value: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('HANDSTACK_RATE_LIMITS_JSON must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('HANDSTACK_RATE_LIMITS_JSON must be an object');
  return parsed as Record<string, number>;
}

function parseRedisNatMap(
  value: string | undefined,
): Record<string, { host: string; port: number }> {
  if (value === undefined || value.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('HANDSTACK_REDIS_NAT_MAP must be valid JSON');
  }
  return redisNatMapSchema.parse(parsed);
}

function parseTrustedPublishers(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('HANDSTACK_PLUGIN_TRUSTED_PUBLISHERS_JSON must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('HANDSTACK_PLUGIN_TRUSTED_PUBLISHERS_JSON must be an object');
  return Object.fromEntries(
    Object.entries(parsed).map(([publisher, key]) => {
      if (publisher.trim() === '' || typeof key !== 'string' || key.trim() === '')
        throw new Error('HANDSTACK_PLUGIN_TRUSTED_PUBLISHERS_JSON entries must be strings');
      return [publisher, key];
    }),
  );
}

function parseCsv(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    ),
  ];
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid port: ${value}`);
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/u.test(value))
    throw new Error('HANDSTACK_REDIS_STREAM_PENDING_CLAIM_IDLE_MS must be a non-negative integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 86_400_000)
    throw new Error('HANDSTACK_REDIS_STREAM_PENDING_CLAIM_IDLE_MS is outside the supported range');
  return parsed;
}
