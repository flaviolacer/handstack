import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const jobs = readFileSync(join(root, 'packages', 'jobs', 'src', 'index.ts'), 'utf8');
const handlers = readFileSync(join(root, 'apps', 'worker', 'src', 'domain-handlers.ts'), 'utf8');
const capabilityController = readFileSync(
  join(root, 'apps', 'api', 'src', 'capabilities', 'capability.controller.ts'),
  'utf8',
);
const databaseService = readFileSync(
  join(root, 'apps', 'api', 'src', 'database', 'database.service.ts'),
  'utf8',
);
const settingsRuntime = readFileSync(
  join(root, 'apps', 'api', 'src', 'settings', 'settings-runtime.service.ts'),
  'utf8',
);
const databaseSettingsController = readFileSync(
  join(root, 'apps', 'api', 'src', 'database', 'database-settings.controller.ts'),
  'utf8',
);
const privacyController = readFileSync(
  join(root, 'apps', 'api', 'src', 'privacy', 'privacy.controller.ts'),
  'utf8',
);
const pluginRuntime = readFileSync(
  join(root, 'apps', 'api', 'src', 'plugins', 'plugin-admin.runtime.ts'),
  'utf8',
);
const coreExecutionContext = readFileSync(
  join(root, 'packages', 'core', 'src', 'execution-context.ts'),
  'utf8',
);
const coreEventBus = readFileSync(join(root, 'packages', 'core', 'src', 'event-bus.ts'), 'utf8');
const evaluation = readFileSync(join(root, 'packages', 'evaluation', 'src', 'index.ts'), 'utf8');
const modelRegistry = readFileSync(
  join(root, 'packages', 'model-registry', 'src', 'index.ts'),
  'utf8',
);
const config = readFileSync(join(root, 'packages', 'config', 'src', 'index.ts'), 'utf8');
const models = readFileSync(join(root, 'packages', 'models', 'src', 'index.ts'), 'utf8');
const knowledge = readFileSync(join(root, 'packages', 'knowledge', 'src', 'index.ts'), 'utf8');
const compose = readFileSync(join(root, 'deploy', 'docker-compose', 'compose.yaml'), 'utf8');
const kubernetes = readFileSync(join(root, 'deploy', 'kubernetes', 'handstack.yaml'), 'utf8');
const openapi = JSON.parse(readFileSync(join(root, 'docs', 'api', 'openapi.json'), 'utf8'));
const catalog = readFileSync(join(root, 'docs', 'requirements', 'catalog.yaml'), 'utf8');
const specificationPath = existsSync(join(root, 'handstack-master-specification-v1.md'))
  ? join(root, 'handstack-master-specification-v1.md')
  : join(root, '..', 'handstack-master-specification-v1.md');
const specification = readFileSync(specificationPath, 'utf8');
const adminNavigation = readFileSync(
  join(root, 'apps', 'web', 'app', 'admin-navigation.tsx'),
  'utf8',
);
const contextualHelp = readFileSync(join(root, 'docs', 'contextual-help.yaml'), 'utf8');
const partialRequirementIds = [];
let currentRequirementId;
let currentRequirementIsPartial = false;
for (const line of catalog.split(/\r?\n/u)) {
  const id = /^\s+- id:\s*([^\s]+)/u.exec(line)?.[1];
  if (id !== undefined) {
    if (currentRequirementId !== undefined && currentRequirementIsPartial)
      partialRequirementIds.push(currentRequirementId);
    currentRequirementId = id;
    currentRequirementIsPartial = false;
  } else if (/^\s+status:\s*partial\b/u.test(line)) {
    currentRequirementIsPartial = true;
  }
}
if (currentRequirementId !== undefined && currentRequirementIsPartial)
  partialRequirementIds.push(currentRequirementId);
const requiredAdminRoutes = [
  'agents',
  'capabilities',
  'models',
  'knowledge',
  'mcp',
  'plugins',
  'users',
  'groups',
  'roles',
  'permissions',
  'policies',
  'budgets',
  'audit',
  'usage',
  'settings',
  'red-team',
];
const requiredAdminUiRoutes = [
  'access-grants',
  'access-requests',
  'agents',
  'api-keys',
  'audit',
  'budgets',
  'capabilities',
  'chat',
  'groups',
  'incidents',
  'knowledge',
  'mcp',
  'models',
  'operations/dead-letters',
  'permissions',
  'plugins',
  'policies',
  'pricing',
  'privacy',
  'providers',
  'red-team',
  'roles',
  'routing',
  'secrets',
  'service-accounts',
  'settings',
  'usage',
  'users',
  'webhooks',
  'workflows',
];
const queues = [...jobs.matchAll(/'([a-z]+(?:-[a-z]+)*)'/g)]
  .map((match) => match[1])
  .filter((value) =>
    [
      'agents',
      'embeddings',
      'documents',
      'plugins',
      'webhooks',
      'audit',
      'billing',
      'cleanup',
      'indexing',
      'workflow-executions',
    ].includes(value),
  );
const uniqueQueues = [...new Set(queues)];
const implementedHandlers = [...handlers.matchAll(/^\s{2}(?:'([^']+)'|([a-z]+(?:-[a-z]+)*)):/gm)]
  .map((match) => match[1] ?? match[2])
  .filter((value) => uniqueQueues.includes(value));
const missingHandlers = uniqueQueues.filter((queue) => !implementedHandlers.includes(queue));
const internalApiHandlers = [
  'agents',
  'embeddings',
  'documents',
  'indexing',
  'plugins',
  'workflow-executions',
].filter((queue) => implementedHandlers.includes(queue));
const contextualHelpRoutes = [...contextualHelp.matchAll(/^\s+route:\s*(\/[^\s]+)/gmu)].map(
  (match) => match[1],
);

// The 105-item catalog is not the whole specification. These are explicit
// Milestone 18 / Definition-of-Done obligations whose repository artifacts are
// contracts or runbooks, not executable certification evidence.
const implementationGaps = [
  'Persistence: production provisioning, backup/restore and upgrade-matrix evidence',
  'Identity/RBAC/SCIM: production provisioning and end-to-end evidence',
  'Models/providers/evaluation: release-grade rollback drill and external red-team certification',
  'Chat/gateway: provider-compatible E2E and deployment evidence for workspace agent execution',
  'Agents: complete deployed Web/MCP/Agent Tool journeys and provider-compatible evidence',
  'Knowledge/RAG: external-provider E2E and complete private synchronization coverage',
  'MCP: external-server connection and publication E2E',
  'Plugins/Marketplace: remote marketplace, malware/dependency scanning and operational E2E',
  'Workflows/Access Grants: deployed-environment worker integration and full scheduler failover drill',
  'Secrets: uniform broker integration across remaining providers and workers',
  'Privacy governance: executable external cache/backup adapters and destination enforcement E2E',
  'Notifications/Webhooks/Incidents/Audit: distributed operation and real-provider E2E evidence',
  'Configuration: startup/production exercise for the already wired operational parameters',
  'SDK/CLI/Help Center: deployed API E2E across the covered domains and complete CLI certification',
  'Event Bus/Execution Context: uniform distributed wiring and auditable propagation',
];

const certificationGaps = [
  'Milestone 18: production database HA/failover certification and backup/restore drill',
  'Milestone 18: multi-zone outage and multi-region DR drill with measured RPO/RTO',
  'Milestone 18: production capacity certification with recorded p95/p99, rates and resource topology',
  'Milestone 18: zero-downtime upgrade and rollback drill against a deployed environment',
  'Definition of Done: external provider contract/E2E runs with real provider-compatible endpoints',
  'Definition of Done: penetration test and threat-model review evidence for the current release',
];
const specificationGaps = [...implementationGaps, ...certificationGaps];

const result = {
  specificationNumberedSections: [...specification.matchAll(/^##\s+\d+\./gmu)].length,
  catalogScopeStatus: /^scopeStatus:\s*(\S+)/mu.exec(catalog)?.[1] ?? 'unspecified',
  openapiPaths: Object.keys(openapi.paths ?? {}).length,
  catalogStatusCounts: {
    verified: (catalog.match(/status:\s*verified/g) ?? []).length,
    implemented: (catalog.match(/status:\s*implemented/g) ?? []).length,
    partial: (catalog.match(/status:\s*partial/g) ?? []).length,
  },
  partialRequirementIds,
  implementationGaps,
  certificationGaps,
  queues: uniqueQueues,
  implementedHandlers,
  internalApiHandlers,
  scopeGaps: specificationGaps,
  specificationGaps,
  missingHandlers,
  settingsRoute: existsSync(join(root, 'apps', 'web', 'app', 'settings', 'page.tsx')),
  adminRoutes: requiredAdminRoutes,
  missingAdminRoutes: requiredAdminRoutes.filter(
    (route) => !existsSync(join(root, 'apps', 'web', 'app', route, 'page.tsx')),
  ),
  adminUiRoutes: requiredAdminUiRoutes.filter((route) =>
    existsSync(join(root, 'apps', 'web', 'app', route, 'page.tsx')),
  ),
  missingAdminUiRoutes: requiredAdminUiRoutes.filter(
    (route) => !existsSync(join(root, 'apps', 'web', 'app', route, 'page.tsx')),
  ),
  missingAdminNavigationRoutes: requiredAdminUiRoutes.filter(
    (route) => !adminNavigation.includes(`'/${route}'`),
  ),
  missingContextualHelpRoutes: requiredAdminUiRoutes
    .map((route) => `/${route}`)
    .filter((route) => !contextualHelpRoutes.includes(route)),
  capabilityAdminRoute:
    capabilityController.includes('@Post()') && capabilityController.includes('capability.manage'),
  globalDatabaseSettingsRoute:
    databaseSettingsController.includes("@Controller('api/v1/admin/settings/database')") &&
    databaseSettingsController.includes('settings.manage'),
  privacyGovernanceRoutes:
    privacyController.includes("@Controller('api/v1/organizations/:organizationId/privacy')") &&
    ['retention', 'legal-holds', 'subject-requests', 'residency'].every((segment) =>
      privacyController.includes(`'${segment}'`),
    ),
  persistentDatabaseSettingsLayer:
    databaseService.includes('loadDatabaseSettings') &&
    databaseService.includes('settings.configuration') &&
    databaseService.includes('resolveConfigLayers'),
  organizationConfigurationLayer:
    settingsRuntime.includes('organizationLayer') &&
    settingsRuntime.includes('resolveConfigLayers'),
  operationalEnvironmentConfiguration:
    config.includes('HANDSTACK_PROVIDER_TIMEOUT_MS') &&
    config.includes('HANDSTACK_RETENTION_AUDIT_DAYS') &&
    config.includes('HANDSTACK_PRIVACY_STORE_TOOL_PAYLOADS') &&
    config.includes('HANDSTACK_RATE_LIMITS_JSON') &&
    config.includes('HANDSTACK_REDIS_NAMESPACE_STREAMS'),
  secureExternalPluginLoader:
    pluginRuntime.includes('pluginArtifact') &&
    pluginRuntime.includes('verifyExternalPluginSignature') &&
    pluginRuntime.includes('verifyExternalPluginAttestations') &&
    pluginRuntime.includes("record.mode !== 'isolated'") &&
    pluginRuntime.includes('Plugin checksum does not match the submitted artifact'),
  isolatedPluginRunner: pluginRuntime.includes('isolatedRpc'),
  gitOpsConfigSync: existsSync(join(root, 'packages', 'cli', 'src', 'sync-command.ts')),
  graphifyPipeline:
    existsSync(join(root, 'scripts', 'graphify.mjs')) &&
    existsSync(join(root, 'graphify-out', 'graph.json')),
  unifiedExecutionContext:
    coreExecutionContext.includes('export interface ExecutionContext') &&
    coreEventBus.includes('export interface EventBus'),
  redTeamCampaignPersistence:
    evaluation.includes('class RedTeamCampaignService') &&
    evaluation.includes('red-team-campaigns'),
  evaluationResultPersistence:
    evaluation.includes('interface EvaluationResult') && evaluation.includes('evaluation-results'),
  modelApprovalPersistence:
    models.includes('interface ModelApproval') && modelRegistry.includes('model-approvals'),
  vectorAdapters: {
    pgvector:
      knowledge.includes('PgVectorStore') ||
      existsSync(join(root, 'packages', 'knowledge', 'src', 'pgvector.ts')),
    mongodbAtlas:
      knowledge.includes('MongoAtlasVectorStore') ||
      existsSync(join(root, 'packages', 'knowledge', 'src', 'mongodb-atlas.ts')),
    qdrant:
      knowledge.includes('QdrantVectorStore') ||
      existsSync(join(root, 'packages', 'knowledge', 'src', 'qdrant.ts')),
    pinecone:
      knowledge.includes('PineconeVectorStore') ||
      existsSync(join(root, 'packages', 'knowledge', 'src', 'pinecone.ts')),
    weaviate:
      knowledge.includes('WeaviateVectorStore') ||
      existsSync(join(root, 'packages', 'knowledge', 'src', 'weaviate.ts')),
    chroma:
      knowledge.includes('ChromaVectorStore') ||
      existsSync(join(root, 'packages', 'knowledge', 'src', 'chroma.ts')),
  },
  composeWorkerServices: [
    'worker-agents',
    'worker-knowledge',
    'worker-integrations',
    'worker-webhooks',
    'worker-audit-billing',
    'worker-maintenance',
    'worker-documents',
    'worker-indexing',
    'worker-billing',
    'worker-workflows',
  ].filter((name) => compose.includes(`${name}:`)),
  workerDockerfile: existsSync(join(root, 'docker', 'worker.Dockerfile')),
  deployedWorkerQueues: [
    'agents',
    'embeddings',
    'documents',
    'plugins',
    'webhooks',
    'audit',
    'billing',
    'cleanup',
    'indexing',
    'workflow-executions',
  ].filter(
    (queue) =>
      compose.includes(`command: ['${queue}']`) || kubernetes.includes(`args: ['${queue}']`),
  ),
};
try {
  result.containers = execFileSync('docker', ['ps', '-aq', '--filter', 'name=handstack'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  result.volumes = execFileSync('docker', ['volume', 'ls', '-q', '--filter', 'name=handstack'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
} catch {
  result.containers = null;
  result.volumes = null;
}

const partial =
  result.specificationGaps.length > 0 ||
  result.catalogStatusCounts.partial > 0 ||
  result.missingHandlers.length > 0 ||
  result.missingAdminRoutes.length > 0 ||
  result.missingAdminUiRoutes.length > 0 ||
  result.missingAdminNavigationRoutes.length > 0 ||
  result.missingContextualHelpRoutes.length > 0 ||
  result.settingsRoute !== true ||
  result.capabilityAdminRoute !== true ||
  result.globalDatabaseSettingsRoute !== true ||
  result.privacyGovernanceRoutes !== true ||
  result.persistentDatabaseSettingsLayer !== true ||
  result.organizationConfigurationLayer !== true ||
  result.secureExternalPluginLoader !== true ||
  result.isolatedPluginRunner !== true ||
  result.gitOpsConfigSync !== true ||
  result.graphifyPipeline !== true ||
  result.unifiedExecutionContext !== true ||
  Object.values(result.vectorAdapters).some((available) => available !== true) ||
  result.composeWorkerServices.length < 10 ||
  result.workerDockerfile !== true ||
  result.deployedWorkerQueues.length !== uniqueQueues.length ||
  result.containers === null ||
  result.volumes === null ||
  result.containers.length > 0 ||
  result.volumes.length > 0;
console.log(
  JSON.stringify(
    { status: partial ? 'PARTIAL' : 'ADHERENT_TO_CHECKED_CONTRACTS', ...result },
    null,
    2,
  ),
);
if (result.missingHandlers.length > 0)
  console.error(`Scope audit: ${result.missingHandlers.length} queue handlers are missing`);
