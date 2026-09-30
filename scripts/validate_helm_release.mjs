import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const chart = join(process.cwd(), 'deploy', 'helm', 'handstack');
const helmCandidates = [
  process.env.HELM_BIN,
  join(process.cwd(), '.handstack-codex', 'helm-bin', 'windows-amd64', 'helm.exe'),
  'helm',
].filter(Boolean);
const helm = helmCandidates.find((candidate) => candidate === 'helm' || existsSync(candidate));
if (helm === undefined) throw new Error('Helm 3 is required for release validation');

function render(...args) {
  return execFileSync(helm, ['template', 'handstack', chart, ...args], { encoding: 'utf8' });
}

const requiredWorkerValues = [
  '--set',
  'workerOrganizationId=release-validation',
  '--set',
  'workerHandlerModule=./domain-handlers.mjs',
];
const baseline = render(
  '--set',
  'images.api.tag=0.1.0',
  '--set',
  'images.web.tag=0.1.0',
  ...requiredWorkerValues,
);
const candidate = render(
  '--set',
  'images.api.tag=0.2.0',
  '--set',
  'images.web.tag=0.2.0',
  '--set',
  'images.worker.tag=0.2.0',
  ...requiredWorkerValues,
);

for (const [name, output] of [
  ['baseline', baseline],
  ['candidate', candidate],
]) {
  if (!output.includes('kind: Deployment')) throw new Error(`${name} has no deployments`);
  if (!output.includes('type: RollingUpdate'))
    throw new Error(`${name} has no rolling update strategy`);
  if (!output.includes('maxUnavailable: 0'))
    throw new Error(`${name} permits unavailable replicas`);
  if (!output.includes('kind: PodDisruptionBudget'))
    throw new Error(`${name} has no disruption budget`);
  if (!output.includes('secretKeyRef:'))
    throw new Error(`${name} does not use explicit secret references`);
  if (output.includes(':latest')) throw new Error(`${name} contains a mutable image tag`);
}

for (const stableName of [
  'handstack-api',
  'handstack-web',
  'handstack-mcp',
  'handstack-worker-agents',
  'handstack-worker-maintenance',
]) {
  if (!baseline.includes(`name: ${stableName}`) || !candidate.includes(`name: ${stableName}`)) {
    throw new Error(`release revision changed stable workload name: ${stableName}`);
  }
}

const rollbackRunbook = join(chart, 'README.md');
if (!existsSync(rollbackRunbook)) throw new Error('chart runbook is missing');
console.log(
  'Helm release validation passed (revision stability, rollout safety, secrets, rollback contract)',
);
