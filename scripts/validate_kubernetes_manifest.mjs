import { readFile } from 'node:fs/promises';
import { parseAllDocuments } from 'yaml';

const path = new URL('../deploy/kubernetes/handstack.yaml', import.meta.url);
const documents = parseAllDocuments(await readFile(path, 'utf8'));
const errors = documents.flatMap((document) => document.errors);
if (errors.length > 0) throw new Error(errors.map((error) => error.message).join('\n'));

const resources = documents.map((document) => document.toJS()).filter(Boolean);
const kinds = new Set(resources.map((resource) => resource.kind));
const failures = [];
if (!kinds.has('ConfigMap')) failures.push('ConfigMap is missing');
if (!kinds.has('Secret')) failures.push('Secret is missing');
const secrets = resources.filter((resource) => resource.kind === 'Secret');
if (!secrets.some((secret) => secret.stringData?.HANDSTACK_INTERNAL_SERVICE_TOKEN !== undefined)) {
  failures.push('internal API-to-worker service token is missing from Secret stringData');
}
if (!secrets.some((secret) => secret.stringData?.HANDSTACK_MASTER_KEY !== undefined)) {
  failures.push('shared HANDSTACK_MASTER_KEY is missing from Secret stringData');
}

const deployments = resources.filter((resource) => resource.kind === 'Deployment');
const requiredDeployments = [
  'handstack-api',
  'handstack-web',
  'handstack-mcp',
  'worker-agents',
  'worker-knowledge',
  'worker-integrations',
  'worker-webhooks',
  'worker-audit-billing',
  'worker-maintenance',
  'worker-workflows',
];
for (const name of requiredDeployments) {
  if (!deployments.some((deployment) => deployment.metadata?.name === name)) {
    failures.push(`required deployment is missing: ${name}`);
  }
}
const workflowWorker = deployments.find(
  (deployment) => deployment.metadata?.name === 'worker-workflows',
);
if (
  !workflowWorker?.spec?.template?.spec?.containers?.some((container) =>
    container.args?.includes('workflow-executions'),
  )
) {
  failures.push('workflow worker does not consume the workflow-executions queue');
}
if (deployments.length < requiredDeployments.length) {
  failures.push(
    `expected at least ${requiredDeployments.length} deployments; found ${deployments.length}`,
  );
}
for (const deployment of deployments) {
  const containers = deployment.spec?.template?.spec?.containers ?? [];
  if (deployment.spec?.template?.spec?.terminationGracePeriodSeconds === undefined) {
    failures.push(`${deployment.metadata?.name} is missing graceful termination`);
  }
  if ((deployment.spec?.template?.spec?.topologySpreadConstraints ?? []).length === 0) {
    failures.push(`${deployment.metadata?.name} is missing topology spread defaults`);
  }
  for (const container of containers) {
    const envFrom = container.envFrom ?? [];
    const names = envFrom.flatMap((entry) => [entry.configMapRef?.name, entry.secretRef?.name]);
    if (deployment.metadata?.name !== 'handstack-web' && !names.includes('handstack-config')) {
      failures.push(`${deployment.metadata?.name} does not reference handstack-config`);
    }
    if (deployment.metadata?.name !== 'handstack-web' && !names.includes('handstack-secrets')) {
      failures.push(`${deployment.metadata?.name} does not reference handstack-secrets`);
    }
    if (container.readinessProbe === undefined)
      failures.push(`${deployment.metadata?.name} is missing readiness probe`);
    if (container.livenessProbe === undefined)
      failures.push(`${deployment.metadata?.name} is missing liveness probe`);
    if (container.resources?.requests === undefined || container.resources?.limits === undefined) {
      failures.push(`${deployment.metadata?.name} is missing resource requests/limits`);
    }
  }
}

const hpAs = resources.filter((resource) => resource.kind === 'HorizontalPodAutoscaler');
for (const name of ['handstack-api', 'handstack-web', 'handstack-mcp']) {
  const hpa = hpAs.find((resource) => resource.metadata?.name === name);
  if (
    hpa === undefined ||
    hpa.spec?.minReplicas === undefined ||
    hpa.spec?.maxReplicas === undefined ||
    hpa.spec.maxReplicas <= hpa.spec.minReplicas
  ) {
    failures.push(`bounded HPA is missing or invalid for ${name}`);
  }
}

const scaledObjects = resources.filter((resource) => resource.kind === 'ScaledObject');
const requiredWorkers = [
  'worker-agents',
  'worker-knowledge',
  'worker-integrations',
  'worker-webhooks',
  'worker-audit-billing',
  'worker-maintenance',
  'worker-workflows',
];
for (const name of requiredWorkers) {
  const scaledObject = scaledObjects.find((resource) => resource.metadata?.name === name);
  if (
    scaledObject === undefined ||
    scaledObject.spec?.minReplicaCount === undefined ||
    scaledObject.spec?.maxReplicaCount === undefined ||
    scaledObject.spec.maxReplicaCount <= scaledObject.spec.minReplicaCount
  ) {
    failures.push(`bounded KEDA ScaledObject is missing or invalid for ${name}`);
  }
}
for (const scaledObject of scaledObjects) {
  const trigger = scaledObject.spec?.triggers?.find((candidate) => candidate.type === 'redis');
  if (trigger?.metadata?.addressFromEnv !== 'HANDSTACK_REDIS_URL') {
    failures.push(`${scaledObject.metadata?.name} must use HANDSTACK_REDIS_URL`);
  }
}
if (!resources.some((resource) => resource.kind === 'PodDisruptionBudget'))
  failures.push('PodDisruptionBudget is missing');
if (
  !resources.some(
    (resource) =>
      resource.kind === 'NetworkPolicy' && resource.metadata?.name === 'handstack-default-deny',
  )
) {
  failures.push('default-deny NetworkPolicy is missing');
}

if (failures.length > 0) throw new Error(failures.join('\n'));
console.log(
  `Kubernetes manifest valid: ${resources.length} documents, ${deployments.length} deployments, ${scaledObjects.length} KEDA ScaledObjects.`,
);
