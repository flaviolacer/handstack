import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const path = join(root, 'deploy', 'docker', 'single-container.contract.json');
const contract = JSON.parse(readFileSync(path, 'utf8'));
const fail = (message) => {
  throw new Error(`Container contract: ${message}`);
};

if (contract.schemaVersion !== 1 || contract.image !== 'handstack/handstack')
  fail('invalid image contract');
if (contract.command !== 'docker run handstack/handstack' || contract.profile !== 'compact')
  fail('single-container command/profile mismatch');
if (
  JSON.stringify(contract.services) !== JSON.stringify(['api', 'web']) ||
  contract.database !== 'sqlite' ||
  contract.redis !== false
)
  fail('compact profile must be API, UI and SQLite without Redis');
if (contract.secretPolicy !== 'external-environment-only')
  fail('secrets must remain outside the image contract');
for (const file of [
  ...contract.sourceDockerfiles,
  contract.composeContract,
  contract.distributedContract,
]) {
  const target = join(root, file);
  if (!existsSync(target)) fail(`missing referenced deployment artifact: ${file}`);
}
for (const endpoint of ['/health/live', '/health/ready']) {
  if (!contract.requiredHealthChecks.includes(endpoint)) fail(`missing health check: ${endpoint}`);
}
const compose = readFileSync(join(root, contract.composeContract), 'utf8');
if (!compose.includes('HANDSTACK_DATABASE_ADAPTER') || !compose.includes('handstack-data:'))
  fail('compose compact defaults are incomplete');
for (const profile of ['profiles: [postgres]', 'profiles: [mongodb]']) {
  if (!compose.includes(profile)) fail(`compose is missing isolated database profile: ${profile}`);
}
if (compose.indexOf('profiles: [postgres]') === compose.indexOf('profiles: [mongodb]'))
  fail('postgres and mongodb profiles must be distinct');
console.log('Container contract passed: single-container compact profile, SQLite, no Redis.');
