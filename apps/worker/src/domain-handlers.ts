import {
  RepositoryWebhookDeliveryStore,
  RepositoryWebhookEndpointStore,
  RepositoryWebhookSecretProvider,
  WebhookDispatcher,
  type WebhookDeliveryStore,
  type WebhookEndpointStore,
  type WebhookEvent,
  type WebhookSecretAccessObserver,
  type WebhookSecretProvider,
  type WebhookTransport,
} from '@handstack/webhooks';
import { isDomainEventContext, MasterKey, type DomainEventContext } from '@handstack/core';
import type { JobContext } from '@handstack/jobs';
import { repositoryName, type TenantEntity } from '@handstack/domain';
import { configFromEnvironment, configLayerFromEnvironment } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { randomUUID } from 'node:crypto';
import {
  RedisAuditAppendCoordinator,
  RepositoryAuditSink,
  TamperEvidentAuditSink,
  WebhookAuditBridge,
  type AuditEvent,
} from '@handstack/audit';
import { Cluster, Redis, type RedisOptions } from 'ioredis';
import { BudgetEngine, type BudgetScopeType, type CostRecord } from '@handstack/budgets';
import type { WorkerHandlerMap } from './main.js';

const EVENTS: readonly WebhookEvent[] = [
  'agent.completed',
  'budget.threshold',
  'access.requested',
  'access.approved',
  'plugin.installed',
  'user.created',
];

function configuredInternalServiceToken(): string | undefined {
  return configLayerFromEnvironment({
    HANDSTACK_INTERNAL_SERVICE_TOKEN: process.env.HANDSTACK_INTERNAL_SERVICE_TOKEN,
  }).security?.internalServiceToken?.trim();
}

function configuredInternalApiKey(): string | undefined {
  return configLayerFromEnvironment({
    HANDSTACK_INTERNAL_API_KEY: process.env.HANDSTACK_INTERNAL_API_KEY,
  }).security?.internalApiKey?.trim();
}

function configuredWorkerOrganization(): string | undefined {
  return configLayerFromEnvironment(process.env).worker?.organizationId?.trim();
}

function configuredWorkerApiUrl(): string | undefined {
  return configLayerFromEnvironment(process.env).worker?.apiUrl?.trim();
}

type WorkerRedisClient = Redis | Cluster;

function createAuditAppendCoordinator():
  | { readonly coordinator: RedisAuditAppendCoordinator; readonly close: () => Promise<void> }
  | undefined {
  const config = configFromEnvironment({
    ...process.env,
    HANDSTACK_DEPLOYMENT_PROFILE: 'distributed',
  });
  if (config.queue.redisUrl === undefined) return undefined;
  const client = createWorkerRedisClient(
    config.queue.redisUrl,
    config.queue.topology,
    config.queue.natMap,
  );
  const coordinator = new RedisAuditAppendCoordinator(
    {
      set: async (key, value, ...options) => {
        const result = await client.call('SET', key, value, ...options);
        return result === 'OK' ? 'OK' : null;
      },
      eval: (script, numberOfKeys, ...arguments_) =>
        client.eval(script, numberOfKeys, ...arguments_),
    },
    { keyPrefix: `${config.queue.namespaces.queues}:audit-lock` },
  );
  return {
    coordinator,
    close: async () => {
      await client.quit();
    },
  };
}

function createWorkerRedisClient(
  redisUrl: string,
  topology: 'standalone' | 'sentinel' | 'cluster',
  natMap: Record<string, { host: string; port: number }>,
): WorkerRedisClient {
  const url = new URL(redisUrl.replace(/^redis\+(?:sentinel|cluster):\/\//u, 'redis://'));
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
  if (topology === 'standalone') return new Redis(options);
  if (topology === 'sentinel')
    return new Redis({
      ...options,
      sentinels: [{ host: url.hostname, port }],
      name: url.searchParams.get('master') ?? 'mymaster',
      ...(Object.keys(natMap).length === 0 ? {} : { natMap }),
    });
  return new Cluster([{ host: url.hostname, port }], {
    redisOptions: options,
  });
}

function executionTraceHeaders(context: JobContext): Record<string, string> {
  return {
    ...(context.requestId === undefined ? {} : { 'x-request-id': context.requestId }),
    ...(context.traceId === undefined ? {} : { 'x-trace-id': context.traceId }),
  };
}

function domainContextFromJobContext(context: JobContext): DomainEventContext | undefined {
  if (
    context.requestId === undefined ||
    context.traceId === undefined ||
    context.principalId === undefined ||
    context.source === undefined ||
    !['WEB', 'API', 'MCP', 'AGENT', 'SYSTEM'].includes(context.source)
  )
    return undefined;
  return {
    requestId: context.requestId,
    traceId: context.traceId,
    principalId: context.principalId,
    source: context.source as DomainEventContext['source'],
  };
}

export function createWebhookSecretAccessObserver(
  appendAuditEvent: (event: AuditEvent) => Promise<void>,
): WebhookSecretAccessObserver {
  return async ({ organizationId, keyId }) =>
    appendAuditEvent({
      id: randomUUID(),
      timestamp: new Date(),
      organizationId,
      actorId: 'system:webhook-worker',
      actorType: 'SYSTEM',
      action: 'SECRET_ACCESSED',
      resourceType: 'secret',
      resourceId: organizationId,
      decision: 'ALLOW',
      metadata: {
        name: 'webhook signing secret',
        pluginId: 'webhook-signing',
        keyId,
        provider: 'repository',
      },
    });
}

/**
 * Restores only bounded execution provenance onto an audit event when the
 * durable job envelope carried it. Payload metadata remains non-authoritative:
 * the worker context is the source of truth for correlation fields.
 */
export function enrichAuditEventWithJobContext(
  event: AuditEvent,
  context: Pick<JobContext, 'requestId' | 'traceId' | 'principalId' | 'source'>,
): AuditEvent {
  return {
    ...event,
    ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
    metadata: {
      ...(event.metadata ?? {}),
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      ...(context.principalId === undefined ? {} : { principalId: context.principalId }),
      ...(context.source === undefined ? {} : { source: context.source }),
    },
  };
}

interface WebhookJobPayload {
  readonly id: string;
  readonly organizationId: string;
  readonly event: WebhookEvent;
  readonly payload: unknown;
  readonly schemaVersion?: string;
  readonly source?: string;
  readonly timestamp?: string;
}

export interface WebhookJobDependencies {
  readonly endpoints: WebhookEndpointStore;
  readonly secrets: WebhookSecretProvider;
  readonly deliveries: WebhookDeliveryStore;
  readonly transport?: WebhookTransport;
  readonly audit?: {
    record(event: {
      readonly type:
        'webhook.attempt' | 'webhook.delivered' | 'webhook.failed' | 'webhook.dead_lettered';
      readonly organizationId: string;
      readonly deliveryId: string;
      readonly event: WebhookEvent;
      readonly attempt: number;
      readonly error?: string;
      readonly context?: DomainEventContext;
    }): Promise<void>;
  };
}

/**
 * Concrete worker handler for the webhook queue. The signing secret is read
 * only at runtime and never carried in the queue payload.
 */
export async function processWebhookJob(
  payload: unknown,
  context: JobContext,
  overrides?: WebhookJobDependencies,
): Promise<void> {
  const job = parseWebhookJob(payload);
  const organizationId = configuredWorkerOrganization();
  if (organizationId === undefined || organizationId === '') {
    throw new Error('HANDSTACK_WORKER_ORGANIZATION_ID is required for webhook jobs');
  }
  if (job.organizationId !== organizationId) {
    throw new Error('Webhook job organization does not match worker organization');
  }
  context.signal.throwIfAborted();
  context.heartbeat();
  let adapter: ReturnType<typeof createDatabaseAdapter> | undefined;
  let auditCoordination:
    | { readonly coordinator: RedisAuditAppendCoordinator; readonly close: () => Promise<void> }
    | undefined;
  try {
    let dependencies = overrides;
    if (dependencies === undefined) {
      const config = configFromEnvironment(process.env);
      const configuredMasterKey = config.security.masterKey;
      const masterKey =
        configuredMasterKey === undefined ? undefined : MasterKey.decode(configuredMasterKey);
      if (masterKey === undefined)
        throw new Error('HANDSTACK_MASTER_KEY is required for worker webhook delivery');
      adapter = createDatabaseAdapter(config);
      await adapter.initialize();
      const database = adapter;
      auditCoordination = createAuditAppendCoordinator();
      const auditSink = new TamperEvidentAuditSink(
        new RepositoryAuditSink((name) => database.repository(name)),
        auditCoordination?.coordinator,
      );
      const legacyMasterKey = config.security.webhookLegacyMasterKey;
      dependencies = {
        endpoints: new RepositoryWebhookEndpointStore((name) => database.repository(name)),
        secrets: new RepositoryWebhookSecretProvider(
          (name) => database.repository(name),
          masterKey,
          legacyMasterKey,
          createWebhookSecretAccessObserver((event) =>
            auditSink.append(event).then(() => undefined),
          ),
        ),
        deliveries: new RepositoryWebhookDeliveryStore((name) => database.repository(name)),
        audit: new WebhookAuditBridge(auditSink),
      };
    }
    const [endpoint, secretSet] = await Promise.all([
      dependencies.endpoints.get(organizationId),
      dependencies.secrets.get(organizationId),
    ]);
    if (endpoint === undefined || secretSet === undefined)
      throw new Error('Tenant webhook endpoint or secret is not configured');
    context.signal.throwIfAborted();
    const allowedEndpointHosts = configFromEnvironment(process.env).webhooks.allowedHosts;
    const auditContext = domainContextFromJobContext(context);
    const dispatcher = new WebhookDispatcher({
      secret: secretSet.current,
      keyId: secretSet.keyId,
      store: dependencies.deliveries,
      transport: dependencies.transport ?? httpWebhookTransport(),
      ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
      ...(endpoint.source === undefined ? {} : { source: endpoint.source }),
      ...(allowedEndpointHosts.length === 0 ? {} : { allowedEndpointHosts }),
    });
    const dispatchInput = {
      ...job,
      endpoint: endpoint.endpoint,
      ...(endpoint.source === undefined ? {} : { source: endpoint.source }),
      keyId: secretSet.keyId,
    };
    const delivery =
      auditContext === undefined
        ? await dispatcher.dispatch(dispatchInput)
        : await dispatcher.dispatch({ ...dispatchInput, context: auditContext });
    if (delivery.status !== 'DELIVERED')
      throw new Error(`Webhook delivery ended as ${delivery.status}`);
    await context.checkpoint({ deliveryId: job.id, status: 'DELIVERED' });
  } finally {
    await adapter?.close();
    await auditCoordination?.close();
  }
}

export const handlers: WorkerHandlerMap = {
  audit: processAuditJob,
  agents: processAgentJob,
  billing: processBillingJob,
  cleanup: processCleanupJob,
  documents: processDocumentJob,
  embeddings: processEmbeddingJob,
  indexing: processIndexingJob,
  plugins: processPluginJob,
  webhooks: processWebhookJob,
  'workflow-executions': processWorkflowExecutionJob,
};

interface WorkflowExecutionJobPayload {
  readonly organizationId: string;
  readonly operationId: string;
  readonly workflowId: string;
  readonly principalId: string;
  readonly context?: DomainEventContext;
  readonly trigger: 'manual' | 'api' | 'webhook' | 'schedule' | 'event';
  readonly payload: unknown;
  readonly idempotencyKey: string;
}

export async function processWorkflowExecutionJob(
  payload: unknown,
  context: JobContext,
): Promise<void> {
  const job = parseWorkflowExecutionJob(payload);
  const organizationId = configuredWorkerOrganization();
  const apiUrl = configuredWorkerApiUrl();
  const token = configuredInternalServiceToken();
  if (organizationId === undefined || organizationId === '')
    throw new Error('HANDSTACK_WORKER_ORGANIZATION_ID is required for workflow jobs');
  if (job.organizationId !== organizationId)
    throw new Error('Workflow job organization does not match worker organization');
  if (apiUrl === undefined || apiUrl === '' || token === undefined || token.length < 32)
    throw new Error(
      'HANDSTACK_API_URL and HANDSTACK_INTERNAL_SERVICE_TOKEN are required for workflow jobs',
    );
  context.signal.throwIfAborted();
  context.heartbeat();
  const propagatedContext = job.context ?? domainContextFromJobContext(context);
  const response = await fetch(`${apiUrl.replace(/\/$/u, '')}/internal/v1/workflows/execute`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...executionTraceHeaders(context),
    },
    body: JSON.stringify({
      ...job,
      ...(propagatedContext === undefined ? {} : { context: propagatedContext }),
    }),
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`Workflow execution returned HTTP ${String(response.status)}`);
  const result: unknown = await response.json();
  await context.checkpoint({ operationId: job.operationId, result, status: 'PROCESSED' });
}

function parseWorkflowExecutionJob(value: unknown): WorkflowExecutionJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Workflow job payload must be an object');
  const candidate = value as Record<string, unknown>;
  const trigger = candidate.trigger;
  const contextValid = candidate.context === undefined || isDomainEventContext(candidate.context);
  if (
    typeof candidate.organizationId !== 'string' ||
    candidate.organizationId.trim() === '' ||
    typeof candidate.operationId !== 'string' ||
    candidate.operationId.trim() === '' ||
    typeof candidate.workflowId !== 'string' ||
    candidate.workflowId.trim() === '' ||
    typeof candidate.principalId !== 'string' ||
    candidate.principalId.trim() === '' ||
    typeof candidate.idempotencyKey !== 'string' ||
    candidate.idempotencyKey.trim() === '' ||
    !['manual', 'api', 'webhook', 'schedule', 'event'].includes(String(trigger)) ||
    !Object.hasOwn(candidate, 'payload') ||
    !contextValid
  )
    throw new Error('Workflow job payload is invalid');
  return {
    organizationId: candidate.organizationId.trim(),
    operationId: candidate.operationId.trim(),
    workflowId: candidate.workflowId.trim(),
    principalId: candidate.principalId.trim(),
    ...(candidate.context === undefined
      ? {}
      : { context: candidate.context as DomainEventContext }),
    trigger: trigger as WorkflowExecutionJobPayload['trigger'],
    payload: candidate.payload,
    idempotencyKey: candidate.idempotencyKey.trim(),
  };
}

/** Reuses the canonical Knowledge ingestion path to rebuild a document index. */
export async function processIndexingJob(payload: unknown, context: JobContext): Promise<void> {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).kind === 'knowledge.reindex'
  ) {
    await processKnowledgeReindexJob(payload, context);
    return;
  }
  await processDocumentJob(payload, context);
}

interface KnowledgeReindexJobPayload {
  readonly organizationId: string;
  readonly jobId: string;
}

async function processKnowledgeReindexJob(payload: unknown, context: JobContext): Promise<void> {
  const job = parseKnowledgeReindexJob(payload);
  const workerOrganization = configuredWorkerOrganization();
  const apiUrl = configuredWorkerApiUrl();
  const token = configuredInternalServiceToken();
  if (workerOrganization === undefined || workerOrganization === '')
    throw new Error('HANDSTACK_WORKER_ORGANIZATION_ID is required for reindex jobs');
  if (job.organizationId !== workerOrganization)
    throw new Error('Knowledge reindex organization does not match worker organization');
  if (apiUrl === undefined || apiUrl === '' || token === undefined || token === '')
    throw new Error(
      'HANDSTACK_API_URL and HANDSTACK_INTERNAL_SERVICE_TOKEN are required for reindex jobs',
    );
  context.signal.throwIfAborted();
  context.heartbeat();
  const response = await fetch(
    `${apiUrl.replace(/\/$/u, '')}/internal/v1/knowledge/reindex-jobs/run`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...executionTraceHeaders(context),
      },
      body: JSON.stringify({ organizationId: workerOrganization, jobId: job.jobId }),
      signal: context.signal,
    },
  );
  if (!response.ok) throw new Error(`Knowledge reindex returned HTTP ${String(response.status)}`);
  const result: unknown = await response.json();
  if (
    typeof result !== 'object' ||
    result === null ||
    !('status' in result) ||
    typeof result.status !== 'string'
  )
    throw new Error('Knowledge reindex response is invalid');
  if (result.status === 'FAILED')
    throw new Error(
      'error' in result && typeof result.error === 'string'
        ? result.error
        : 'Knowledge reindex failed',
    );
  await context.checkpoint({ jobId: job.jobId, status: result.status });
}

function parseKnowledgeReindexJob(value: unknown): KnowledgeReindexJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Knowledge reindex job payload must be an object');
  const candidate = value as Record<string, unknown>;
  const organizationId = candidate.organizationId;
  const jobId = candidate.jobId;
  if (
    typeof organizationId !== 'string' ||
    organizationId.trim() === '' ||
    typeof jobId !== 'string' ||
    jobId.trim() === ''
  )
    throw new Error('Knowledge reindex organizationId and jobId are required');
  return { organizationId: organizationId.trim(), jobId: jobId.trim() };
}

interface AgentJobPayload {
  readonly organizationId: string;
  readonly agentId: string;
  readonly prompt: string;
}

export async function processAgentJob(payload: unknown, context: JobContext): Promise<void> {
  const job = parseAgentJob(payload);
  const organizationId = configuredWorkerOrganization();
  const apiUrl = configuredWorkerApiUrl();
  const token = configuredInternalServiceToken();
  if (organizationId === undefined || organizationId === '')
    throw new Error('HANDSTACK_WORKER_ORGANIZATION_ID is required for agent jobs');
  if (job.organizationId !== organizationId)
    throw new Error('Agent job organization does not match worker organization');
  if (apiUrl === undefined || apiUrl === '' || token === undefined || token === '')
    throw new Error(
      'HANDSTACK_API_URL and HANDSTACK_INTERNAL_SERVICE_TOKEN are required for agent jobs',
    );
  if (context.signal.aborted) throw new Error('Agent job cancelled');
  context.heartbeat();
  const response = await fetch(
    `${apiUrl.replace(/\/$/u, '')}/api/v1/agents/${encodeURIComponent(job.agentId)}/run`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...executionTraceHeaders(context),
      },
      body: JSON.stringify({
        prompt: job.prompt,
      }),
      signal: context.signal,
    },
  );
  if (!response.ok) throw new Error(`Agent execution returned HTTP ${String(response.status)}`);
  const result: unknown = await response.json();
  await context.checkpoint({ agentId: job.agentId, result, status: 'SUCCEEDED' });
}

function parseAgentJob(value: unknown): AgentJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Agent job payload must be an object');
  const candidate = value as Record<string, unknown>;
  const organizationId = candidate.organizationId;
  const agentId = candidate.agentId;
  const prompt = candidate.prompt;
  if (
    typeof organizationId !== 'string' ||
    organizationId.trim() === '' ||
    typeof agentId !== 'string' ||
    agentId.trim() === ''
  )
    throw new Error('Agent organizationId and agentId are required');
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > 100_000)
    throw new Error('Agent prompt is invalid');
  return {
    organizationId: organizationId.trim(),
    agentId: agentId.trim(),
    prompt,
  };
}

interface PluginJobPayload {
  readonly organizationId: string;
  readonly operation: 'install' | 'upgrade' | 'enable' | 'disable' | 'uninstall';
  readonly pluginName: string;
  readonly body?: unknown;
}

export async function processPluginJob(payload: unknown, context: JobContext): Promise<void> {
  const job = parsePluginJob(payload);
  const organizationId = configuredWorkerOrganization();
  const apiUrl = configuredWorkerApiUrl();
  const token = configuredInternalServiceToken();
  if (organizationId === undefined || organizationId === '')
    throw new Error('HANDSTACK_WORKER_ORGANIZATION_ID is required for plugin jobs');
  if (job.organizationId !== organizationId)
    throw new Error('Plugin job organization does not match worker organization');
  if (apiUrl === undefined || apiUrl === '' || token === undefined || token === '')
    throw new Error(
      'HANDSTACK_API_URL and HANDSTACK_INTERNAL_SERVICE_TOKEN are required for plugin jobs',
    );
  if (context.signal.aborted) throw new Error('Plugin job cancelled');
  context.heartbeat();
  const method =
    job.operation === 'uninstall' ? 'DELETE' : job.operation === 'install' ? 'POST' : 'PATCH';
  const suffix =
    job.operation === 'install' ? '' : `/${encodeURIComponent(job.pluginName)}/${job.operation}`;
  const response = await fetch(
    `${apiUrl.replace(/\/$/u, '')}/api/v1/organizations/${encodeURIComponent(organizationId)}/plugins${suffix}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...executionTraceHeaders(context),
        ...(job.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(job.body === undefined ? {} : { body: JSON.stringify(job.body) }),
      signal: context.signal,
    },
  );
  if (!response.ok)
    throw new Error(`Plugin ${job.operation} returned HTTP ${String(response.status)}`);
  await context.checkpoint({
    pluginName: job.pluginName,
    operation: job.operation,
    status: 'SUCCEEDED',
  });
}

function parsePluginJob(value: unknown): PluginJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Plugin job payload must be an object');
  const candidate = value as Record<string, unknown>;
  const organizationId = candidate.organizationId;
  const pluginName = candidate.pluginName;
  const operation = candidate.operation;
  if (
    typeof organizationId !== 'string' ||
    organizationId.trim() === '' ||
    typeof pluginName !== 'string' ||
    pluginName.trim() === ''
  )
    throw new Error('Plugin organizationId and pluginName are required');
  if (!['install', 'upgrade', 'enable', 'disable', 'uninstall'].includes(String(operation)))
    throw new Error('Plugin operation is invalid');
  if (
    (operation === 'install' || operation === 'upgrade') &&
    (candidate.body === undefined ||
      typeof candidate.body !== 'object' ||
      candidate.body === null ||
      Array.isArray(candidate.body))
  )
    throw new Error('Plugin installation body is required');
  return {
    organizationId: organizationId.trim(),
    pluginName: pluginName.trim(),
    operation: operation as PluginJobPayload['operation'],
    ...(candidate.body === undefined ? {} : { body: candidate.body }),
  };
}

interface EmbeddingJobPayload {
  readonly organizationId: string;
  readonly model: string;
  readonly input: readonly string[];
}

export async function processEmbeddingJob(payload: unknown, context: JobContext): Promise<void> {
  const job = parseEmbeddingJob(payload);
  const organizationId = configuredWorkerOrganization();
  if (organizationId === undefined || organizationId === '')
    throw new Error('HANDSTACK_WORKER_ORGANIZATION_ID is required for embedding jobs');
  if (job.organizationId !== organizationId)
    throw new Error('Embedding job organization does not match worker organization');
  const apiUrl = configuredWorkerApiUrl();
  const token = configuredInternalApiKey();
  if (apiUrl === undefined || apiUrl === '' || token === undefined || token === '')
    throw new Error(
      'HANDSTACK_API_URL and HANDSTACK_INTERNAL_API_KEY are required for embedding jobs',
    );
  if (context.signal.aborted) throw new Error('Embedding job cancelled');
  context.heartbeat();
  const response = await fetch(`${apiUrl.replace(/\/$/u, '')}/v1/embeddings`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...executionTraceHeaders(context),
    },
    body: JSON.stringify({ model: job.model, input: job.input }),
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`Embedding execution returned HTTP ${String(response.status)}`);
  const result: unknown = await response.json();
  if (
    typeof result !== 'object' ||
    result === null ||
    !Array.isArray((result as { data?: unknown }).data)
  )
    throw new Error('Embedding execution returned an invalid response');
  await context.checkpoint({
    model: job.model,
    count: (result as { data: unknown[] }).data.length,
    status: 'EMBEDDED',
  });
}

function parseEmbeddingJob(value: unknown): EmbeddingJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Embedding job payload must be an object');
  const candidate = value as Record<string, unknown>;
  const organizationId = candidate.organizationId;
  const model = candidate.model;
  const input = candidate.input;
  if (
    typeof organizationId !== 'string' ||
    organizationId.trim() === '' ||
    typeof model !== 'string' ||
    model.trim() === ''
  )
    throw new Error('Embedding organizationId and model are required');
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > 2048 ||
    input.some((item) => typeof item !== 'string' || item.length > 1_000_000)
  )
    throw new Error('Embedding input is invalid');
  return { organizationId: organizationId.trim(), model: model.trim(), input };
}

interface DocumentJobPayload {
  readonly organizationId: string;
  readonly documentId: string;
  readonly content: string;
}

export async function processDocumentJob(payload: unknown, context: JobContext): Promise<void> {
  const job = parseDocumentJob(payload);
  const organizationId = configuredWorkerOrganization();
  if (organizationId === undefined || organizationId === '')
    throw new Error('HANDSTACK_WORKER_ORGANIZATION_ID is required for document jobs');
  if (job.organizationId !== organizationId)
    throw new Error('Document job organization does not match worker organization');
  const apiUrl = configuredWorkerApiUrl();
  const token = configuredInternalServiceToken();
  if (apiUrl === undefined || apiUrl === '' || token === undefined || token === '')
    throw new Error(
      'HANDSTACK_API_URL and HANDSTACK_INTERNAL_SERVICE_TOKEN are required for document jobs',
    );
  if (context.signal.aborted) throw new Error('Document job cancelled');
  context.heartbeat();
  const response = await fetch(
    `${apiUrl.replace(/\/$/u, '')}/api/v1/organizations/${encodeURIComponent(organizationId)}/knowledge/documents/${encodeURIComponent(job.documentId)}/ingest`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...executionTraceHeaders(context),
      },
      body: JSON.stringify({ content: job.content }),
      signal: context.signal,
    },
  );
  if (!response.ok) throw new Error(`Document ingestion returned HTTP ${String(response.status)}`);
  await context.checkpoint({ documentId: job.documentId, status: 'INGESTED' });
}

function parseDocumentJob(value: unknown): DocumentJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Document job payload must be an object');
  const candidate = value as Record<string, unknown>;
  const required = (key: string): string => {
    const item = candidate[key];
    if (typeof item !== 'string' || item.trim() === '')
      throw new Error(`Document ${key} is required`);
    return item;
  };
  return {
    organizationId: required('organizationId').trim(),
    documentId: required('documentId').trim(),
    content: required('content'),
  };
}

export async function processBillingJob(payload: unknown, context: JobContext): Promise<void> {
  const job = parseBillingJob(payload);
  const organizationId = configuredWorkerOrganization();
  if (organizationId === undefined || organizationId === '')
    throw new Error('HANDSTACK_WORKER_ORGANIZATION_ID is required for billing jobs');
  if (job.organizationId !== organizationId)
    throw new Error('Billing job organization does not match worker organization');
  if (context.signal.aborted) throw new Error('Billing job cancelled');
  context.heartbeat();
  const adapter = createDatabaseAdapter(configFromEnvironment(process.env));
  await adapter.initialize();
  try {
    const settled = await new BudgetEngine(adapter).settle({
      organizationId,
      reservationId: job.reservationId,
      actualUsd: job.actualUsd,
      usage: job.usage,
      ...(job.source === undefined ? {} : { source: job.source }),
      ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
    });
    await context.checkpoint({
      reservationId: settled.reservation.id,
      costId: settled.cost.id,
      status: 'SETTLED',
    });
  } finally {
    await adapter.close();
  }
}

interface BillingJobPayload {
  readonly organizationId: string;
  readonly reservationId: string;
  readonly actualUsd: number;
  readonly usage: {
    readonly scopeType: BudgetScopeType;
    readonly scopeKey: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly model?: string;
    readonly provider?: string;
  };
  readonly source?: CostRecord['source'];
}

function parseBillingJob(value: unknown): BillingJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Billing job payload must be an object');
  const candidate = value as Record<string, unknown>;
  const usage = candidate.usage;
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage))
    throw new Error('Billing usage is required');
  const details = usage as Record<string, unknown>;
  const requiredString = (record: Record<string, unknown>, key: string): string => {
    const item = record[key];
    if (typeof item !== 'string' || item.trim() === '')
      throw new Error(`Billing ${key} is required`);
    return item.trim();
  };
  const numberValue = (record: Record<string, unknown>, key: string): number => {
    const item = record[key];
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0)
      throw new Error(`Billing ${key} is invalid`);
    return item;
  };
  const scopeType = requiredString(details, 'scopeType');
  if (
    ![
      'ORGANIZATION',
      'GROUP',
      'USER',
      'API_KEY',
      'APPLICATION',
      'AGENT',
      'MODEL',
      'PROVIDER',
      'CAPABILITY',
    ].includes(scopeType)
  )
    throw new Error('Billing scopeType is invalid');
  const source = candidate.source;
  if (
    source !== undefined &&
    (typeof source !== 'string' || !['MODEL', 'TOOL', 'CAPABILITY'].includes(source))
  )
    throw new Error('Billing source is invalid');
  return {
    organizationId: requiredString(candidate, 'organizationId'),
    reservationId: requiredString(candidate, 'reservationId'),
    actualUsd: numberValue(candidate, 'actualUsd'),
    usage: {
      scopeType: scopeType as BudgetScopeType,
      scopeKey: requiredString(details, 'scopeKey'),
      inputTokens: numberValue(details, 'inputTokens'),
      outputTokens: numberValue(details, 'outputTokens'),
      ...(typeof details.model === 'string' ? { model: details.model } : {}),
      ...(typeof details.provider === 'string' ? { provider: details.provider } : {}),
    },
    ...(source === undefined ? {} : { source: source as CostRecord['source'] }),
  };
}

const CLEANUP_REPOSITORIES = new Set([
  'audit-events',
  'conversation-stream-events',
  'knowledge-document-versions',
  'operations',
  'workflow-executions',
]);

interface CleanupJobPayload {
  readonly organizationId: string;
  readonly repository: string;
  readonly entityIds: readonly string[];
}

export async function processCleanupJob(payload: unknown, context: JobContext): Promise<void> {
  const job = parseCleanupJob(payload);
  const organizationId = configuredWorkerOrganization();
  if (organizationId === undefined || organizationId === '')
    throw new Error('HANDSTACK_WORKER_ORGANIZATION_ID is required for cleanup jobs');
  if (job.organizationId !== organizationId)
    throw new Error('Cleanup job organization does not match worker organization');
  if (context.signal.aborted) throw new Error('Cleanup job cancelled');
  context.heartbeat();
  const adapter = createDatabaseAdapter(configFromEnvironment(process.env));
  await adapter.initialize();
  let deleted = 0;
  try {
    const repository = adapter.repository<TenantEntity>(repositoryName(job.repository));
    const holdsRepository = adapter.repository<LegalHoldEntity>(repositoryName('legal-holds'));
    const holds = (await holdsRepository.list(organizationId, { limit: 200 })).items.filter(
      (hold) => hold.active,
    );
    let retained = 0;
    for (const id of job.entityIds) {
      const entity = await repository.findById(organizationId, id);
      if (entity !== undefined) {
        const held = holds.some(
          (hold) =>
            (hold.resourceType === undefined || hold.resourceType === job.repository) &&
            (hold.resourceId === undefined || hold.resourceId === entity.id),
        );
        if (held) {
          retained += 1;
          continue;
        }
        await repository.delete(organizationId, entity.id, entity.version);
        deleted += 1;
      }
      context.heartbeat();
    }
    await context.checkpoint({ repository: job.repository, deleted, retained });
  } finally {
    await adapter.close();
  }
}

interface LegalHoldEntity extends TenantEntity {
  readonly organizationId: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly reason: string;
  readonly active: boolean;
}

export function parseCleanupJob(value: unknown): CleanupJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Cleanup job payload must be an object');
  const candidate = value as Record<string, unknown>;
  const organizationId = candidate.organizationId;
  const repository = candidate.repository;
  const entityIds = candidate.entityIds;
  if (typeof organizationId !== 'string' || organizationId.trim() === '')
    throw new Error('Cleanup organizationId is required');
  if (typeof repository !== 'string' || !CLEANUP_REPOSITORIES.has(repository))
    throw new Error('Cleanup repository is not allow-listed');
  if (
    !Array.isArray(entityIds) ||
    entityIds.length === 0 ||
    entityIds.some((id) => typeof id !== 'string' || id.trim() === '')
  )
    throw new Error('Cleanup entityIds are required');
  return {
    organizationId: organizationId.trim(),
    repository,
    entityIds: entityIds.map((id) => (id as string).trim()),
  };
}

export async function processAuditJob(payload: unknown, context: JobContext): Promise<void> {
  const event = parseAuditEvent(payload);
  const organizationId = configuredWorkerOrganization();
  if (organizationId === undefined || organizationId === '')
    throw new Error('HANDSTACK_WORKER_ORGANIZATION_ID is required for audit jobs');
  if (event.organizationId !== organizationId)
    throw new Error('Audit event organization does not match worker organization');
  if (context.signal.aborted) throw new Error('Audit job cancelled');
  context.heartbeat();
  const adapter = createDatabaseAdapter(configFromEnvironment(process.env));
  await adapter.initialize();
  const auditCoordination = createAuditAppendCoordinator();
  try {
    const sink = new TamperEvidentAuditSink(
      new RepositoryAuditSink((name) => adapter.repository(name)),
      auditCoordination?.coordinator,
    );
    await sink.append(enrichAuditEventWithJobContext(event, context));
    await context.checkpoint({ eventId: event.id, status: 'APPENDED' });
  } finally {
    await adapter.close();
    await auditCoordination?.close();
  }
}

function parseAuditEvent(value: unknown): AuditEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Audit job payload must be an audit event object');
  const candidate = value as Record<string, unknown>;
  const required = (key: string): string => {
    const item = candidate[key];
    if (typeof item !== 'string' || item.trim() === '')
      throw new Error(`Audit event ${key} is required`);
    return item.trim();
  };
  const timestamp = required('timestamp');
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Audit event timestamp is invalid');
  const actorType = candidate.actorType;
  const decision = candidate.decision;
  if (!['USER', 'SERVICE', 'SYSTEM'].includes(String(actorType)))
    throw new Error('Audit event actorType is invalid');
  if (decision !== 'ALLOW' && decision !== 'DENY')
    throw new Error('Audit event decision is invalid');
  return {
    id: required('id'),
    timestamp: new Date(timestamp),
    organizationId: required('organizationId'),
    actorId: required('actorId'),
    actorType: actorType as AuditEvent['actorType'],
    action: required('action'),
    resourceType: required('resourceType'),
    ...(typeof candidate.resourceId === 'string' ? { resourceId: candidate.resourceId } : {}),
    decision,
    ...(typeof candidate.ip === 'string' ? { ip: candidate.ip } : {}),
    ...(typeof candidate.userAgent === 'string' ? { userAgent: candidate.userAgent } : {}),
    ...(typeof candidate.traceId === 'string' ? { traceId: candidate.traceId } : {}),
    ...(typeof candidate.metadata === 'object' &&
    candidate.metadata !== null &&
    !Array.isArray(candidate.metadata)
      ? {
          metadata: Object.fromEntries(
            Object.entries(candidate.metadata).filter(([, item]) => typeof item === 'string'),
          ),
        }
      : {}),
  };
}

function parseWebhookJob(value: unknown): WebhookJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Webhook job payload must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const id = requiredString(candidate, 'id');
  const organizationId = requiredString(candidate, 'organizationId');
  const event = candidate.event;
  if (typeof event !== 'string' || !EVENTS.includes(event as WebhookEvent)) {
    throw new Error('Webhook job event is invalid');
  }
  return {
    id,
    organizationId,
    event: event as WebhookEvent,
    payload: candidate.payload,
    ...(typeof candidate.schemaVersion === 'string'
      ? { schemaVersion: candidate.schemaVersion }
      : {}),
    ...(typeof candidate.source === 'string' ? { source: candidate.source } : {}),
    ...(typeof candidate.timestamp === 'string' ? { timestamp: candidate.timestamp } : {}),
  };
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error(`Webhook job ${key} is required`);
  }
  return candidate.trim();
}

function httpWebhookTransport(): WebhookTransport {
  return {
    send: async ({ endpoint, body, signature }) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-handstack-signature': signature,
        },
        body,
      });
      if (!response.ok)
        throw new Error(`Webhook endpoint returned HTTP ${String(response.status)}`);
    },
  };
}
