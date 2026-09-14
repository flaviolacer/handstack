import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(process.cwd(), 'deploy', 'helm', 'handstack');
const required = [
  'Chart.yaml',
  'values.yaml',
  'values.schema.json',
  'templates/configmap.yaml',
  'templates/deployments.yaml',
  'templates/services.yaml',
  'templates/autoscaling.yaml',
  'templates/keda.yaml',
  'templates/pdb.yaml',
  'templates/networkpolicy.yaml',
  'templates/serviceaccount.yaml',
];

for (const relative of required) {
  await readFile(join(root, relative), 'utf8');
}

const values = await readFile(join(root, 'values.yaml'), 'utf8');
const deployment = await readFile(join(root, 'templates', 'deployments.yaml'), 'utf8');
const keda = await readFile(join(root, 'templates', 'keda.yaml'), 'utf8');
const chart = await readFile(join(root, 'Chart.yaml'), 'utf8');
const templates = await readdir(join(root, 'templates'));

const requiredValues = [
  'deploymentProfile: distributed',
  'adapter: postgresql',
  'topology: sentinel',
  'externalSecrets:',
  'autoscaling:',
  'keda:',
  'pdb:',
  'networkPolicy:',
  'topologySpread: true',
];
for (const value of requiredValues) {
  if (!values.includes(value)) throw new Error(`missing chart value contract: ${value}`);
}

for (const token of [
  'podAntiAffinity:',
  'topologySpreadConstraints:',
  'terminationGracePeriodSeconds:',
  'readinessProbe:',
  'livenessProbe:',
  'RollingUpdate',
]) {
  if (!deployment.includes(token)) throw new Error(`missing deployment safety contract: ${token}`);
}
for (const worker of [
  'agents',
  'knowledge',
  'integrations',
  'webhooks',
  'auditBilling',
  'maintenance',
]) {
  if (!values.includes(`${worker}:`)) throw new Error(`missing worker class: ${worker}`);
}
if (!keda.includes('keda.sh/v1alpha1') || !keda.includes('addressFromEnv: HANDSTACK_REDIS_URL')) {
  throw new Error('KEDA Redis contract is incomplete');
}
const templateContracts = {
  'templates/services.yaml': ['kind: Service', 'type: ClusterIP'],
  'templates/autoscaling.yaml': ['kind: HorizontalPodAutoscaler', 'autoscaling/v2'],
  'templates/pdb.yaml': ['kind: PodDisruptionBudget', 'policy/v1'],
  'templates/networkpolicy.yaml': ['kind: NetworkPolicy', 'policyTypes: [Ingress, Egress]'],
  'templates/serviceaccount.yaml': ['kind: ServiceAccount', 'automountServiceAccountToken:'],
  'templates/ingress.yaml': ['kind: Ingress', 'networking.k8s.io/v1'],
};
for (const [relative, tokens] of Object.entries(templateContracts)) {
  const source = await readFile(join(root, relative), 'utf8');
  for (const token of tokens) {
    if (!source.includes(token)) throw new Error(`${relative} is missing ${token}`);
  }
}
if (!deployment.includes('include "handstack.serviceAccountName"')) {
  throw new Error('deployments must support serviceAccount.create=false');
}
if (!deployment.includes('include "handstack.env"')) {
  throw new Error('deployments must inject canonical database and Redis environment variables');
}
if (deployment.includes('secretRef: { name: {{ include "handstack.secretName"')) {
  throw new Error('deployments must not import hyphenated Secret keys through envFrom');
}
const helmCandidates = [
  process.env.HELM_BIN,
  join(process.cwd(), '.handstack-codex', 'helm-bin', 'windows-amd64', 'helm.exe'),
  'helm',
].filter(Boolean);
const helm = helmCandidates.find((candidate) => candidate === 'helm' || existsSync(candidate));
if (helm) {
  const rendered = execFileSync(helm, ['template', 'handstack', root], { encoding: 'utf8' });
  if (!rendered.includes('kind: Deployment') || !rendered.includes('kind: ScaledObject')) {
    throw new Error('rendered chart is missing workload or KEDA resources');
  }
  const disabledAccount = execFileSync(
    helm,
    ['template', 'handstack', root, '--set', 'serviceAccount.create=false'],
    { encoding: 'utf8' },
  );
  if (!disabledAccount.includes('serviceAccountName: default')) {
    throw new Error('rendered deployments must fall back to the default ServiceAccount');
  }
}
if (chart.includes('latest')) throw new Error('chart metadata must not use mutable latest tags');
if (templates.length < 10) throw new Error('chart template set is incomplete');
console.log(`Helm chart structural validation passed (${templates.length} templates)`);
