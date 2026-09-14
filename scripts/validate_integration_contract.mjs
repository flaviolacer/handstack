import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const contractPath = join(root, 'deploy', 'integrations', 'handstack-integration-contract.json');
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const fail = (message) => {
  throw new Error(`Integration contract: ${message}`);
};

if (contract.schemaVersion !== 1 || contract.product !== 'handstack')
  fail('unsupported schema or product');
const policy = contract.securityPolicy;
if (
  policy.defaultDecision !== 'deny' ||
  policy.tenantScopeField !== 'organizationId' ||
  policy.secretStorage !== 'external-secret-provider' ||
  !Array.isArray(policy.requiredRedactions) ||
  policy.requiredRedactions.length < 6
)
  fail('deny-by-default, tenant scope, secret storage or redaction policy is incomplete');

const ids = new Set();
for (const integration of contract.integrations) {
  if (ids.has(integration.id)) fail(`duplicate integration id ${integration.id}`);
  ids.add(integration.id);
  for (const field of ['boundaryPackage', 'implementation', 'controller', 'secretStorage']) {
    if (typeof integration[field] !== 'string' || integration[field].length === 0)
      fail(`${integration.id} is missing ${field}`);
  }
  for (const file of [integration.implementation, integration.controller]) {
    if (!existsSync(join(root, file))) fail(`${integration.id} references missing ${file}`);
  }
  if (
    integration.tenantScoped !== true ||
    integration.timeoutMs < 1000 ||
    integration.timeoutMs > 30000 ||
    integration.maxAttempts < 1 ||
    integration.maxAttempts > 5 ||
    typeof integration.idempotency !== 'string' ||
    integration.transport !== 'replaceable'
  )
    fail(`${integration.id} lacks bounded, tenant-scoped, replaceable execution`);
  if (integration.secretStorage.toLowerCase().includes('config'))
    fail(`${integration.id} stores secrets in configuration`);
  if (integration.kind === 'webhook' && integration.authentication !== 'hmac-sha256')
    fail('webhooks must use HMAC-SHA256');
  if (integration.kind === 'webhook' && integration.deadLetter !== true)
    fail('webhooks must retain failed deliveries in a dead-letter boundary');
  if (
    integration.kind === 'identity-provider' &&
    integration.authentication !== 'oidc-state-nonce-pkce'
  )
    fail('OIDC must declare state, nonce and PKCE validation');
}

const serialized = JSON.stringify(contract.integrations);
for (const field of policy.forbiddenArtifactFields) {
  if (serialized.includes(`"${field}"`)) fail(`forbidden secret-bearing field ${field} is present`);
}
if (serialized.match(/(sk-[A-Za-z0-9]{20,}|-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----)/))
  fail('credential-shaped value found in integration contract');

console.log(
  `Integration contract passed: ${contract.integrations.length} integrations, deny-by-default, tenant-scoped.`,
);
