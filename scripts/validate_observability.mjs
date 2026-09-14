import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const readJson = (relativePath) => JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
const dashboard = readJson('deploy/observability/handstack-slo-dashboard.json');
const alerts = readJson('deploy/observability/handstack-alert-rules.json');
const catalog = readJson('deploy/observability/handstack-metric-catalog.json');
const metricsSource = readFileSync(
  resolve(root, 'apps/api/src/observability/api-metrics.ts'),
  'utf8',
);
const runtimeMetrics = new Set(
  [...metricsSource.matchAll(/'([a-z][a-z0-9_]+)'/g)].map((match) => match[1]),
);
if (
  catalog.schemaVersion !== 1 ||
  catalog.privacyPolicy?.labelPolicy !== 'bounded-operational-dimensions-only'
)
  throw new Error('Observability metric catalog schema or privacy policy is invalid');
const catalogEntries = catalog.metrics;
const catalogByName = new Map(catalogEntries.map((metric) => [metric.name, metric]));
if (catalogByName.size !== catalogEntries.length)
  throw new Error('Observability metric catalog contains duplicate names');
const forbiddenLabels = new Set(catalog.privacyPolicy.forbiddenLabels);
for (const metric of catalogEntries) {
  if (!['counter', 'gauge'].includes(metric.type) || !Array.isArray(metric.allowedLabels))
    throw new Error(`Invalid metric catalog entry: ${metric.name}`);
  const unsafe = metric.allowedLabels.filter((label) => forbiddenLabels.has(label));
  if (unsafe.length > 0)
    throw new Error(`Metric ${metric.name} contains forbidden labels: ${unsafe.join(', ')}`);
}
const missingRuntimeCatalog = [...runtimeMetrics].filter(
  (name) => name.startsWith('handstack_') && !catalogByName.has(name),
);
if (missingRuntimeCatalog.length > 0)
  throw new Error(`Runtime metrics missing from catalog: ${missingRuntimeCatalog.join(', ')}`);
const metricNames = [
  ...new Set([
    ...dashboard.panels.flatMap((panel) => panel.metrics),
    ...alerts.groups.flatMap((group) =>
      group.rules.flatMap((rule) =>
        [...rule.expr.matchAll(/\b[a-z][a-z0-9_:]*/g)].map((match) => match[0]),
      ),
    ),
  ]),
].filter(
  (name) => name.startsWith('handstack_') || name.startsWith('kube_') || name.startsWith('redis_'),
);
const missing = metricNames.filter((name) => !catalogByName.has(name));
if (missing.length > 0)
  throw new Error(`Observability references metrics absent from catalog: ${missing.join(', ')}`);

const requiredPanelIds = [
  'http',
  'streams',
  'runtime',
  'autoscaling',
  'queues',
  'workers',
  'redis',
  'database',
  'providers',
  'budgets',
  'storage',
  'slo',
];
const panelIds = new Set(dashboard.panels.map((panel) => panel.id));
const absentPanels = requiredPanelIds.filter((id) => !panelIds.has(id));
if (absentPanels.length > 0)
  throw new Error(`Observability dashboard is missing panels: ${absentPanels.join(', ')}`);

const rules = alerts.groups.flatMap((group) => group.rules);
const requiredAlerts = [
  'HandStackApiP95LatencyHigh',
  'HandStackQueueWaitHigh',
  'HandStackMaxReplicasSaturated',
  'HandStackRedisDegraded',
];
const alertNames = new Set(rules.map((rule) => rule.alert));
const absentAlerts = requiredAlerts.filter((name) => !alertNames.has(name));
if (absentAlerts.length > 0)
  throw new Error(`Observability alert contract is missing: ${absentAlerts.join(', ')}`);
if (
  JSON.stringify({ dashboard, alerts }).match(
    /(authorization|password|secret|token|prompt|payload)/i,
  )
) {
  throw new Error('Observability artifacts contain a forbidden sensitive field or value');
}
for (const rule of rules) {
  if (!rule.runbook || !rule.severity || !rule.for)
    throw new Error(`Alert ${rule.alert} lacks severity, duration or runbook`);
}
console.log(
  `Observability contract passed: ${catalogEntries.length} metrics, ${dashboard.panels.length} panels, ${rules.length} alerts.`,
);
