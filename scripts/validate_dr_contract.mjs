import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const file = join(root, 'deploy', 'resilience', 'multi-region-dr.contract.json');
const contract = JSON.parse(readFileSync(file, 'utf8'));
const fail = (message) => {
  throw new Error(`DR contract: ${message}`);
};

if (contract.schemaVersion !== 1 || contract.writeTopology !== 'active-standby')
  fail('writes must use active/standby topology');
if (contract.activeRegion === contract.standbyRegion || contract.standbyRegion !== 'warm')
  fail('active and warm standby regions must be distinct');
if (contract.globalFailover !== 'health-based-dns') fail('global failover must be health based');
if (contract.rpoMinutes > 5 || contract.rtoMinutes > 15) fail('RPO/RTO exceed product targets');
for (const flag of ['fencingRequired', 'consistencyValidationRequired', 'smokeBeforeTraffic'])
  if (contract[flag] !== true) fail(`${flag} is required`);
if (contract.failback?.separateOperation !== true || contract.failback.auditRequired !== true)
  fail('failback must be separate and audited');
for (const dependency of ['database', 'object-storage', 'secrets-config'])
  if (!contract.replication.includes(dependency)) fail(`missing replication: ${dependency}`);
for (const service of ['web', 'api', 'mcp', 'workers'])
  if (!contract.statelessServices.includes(service)) fail(`missing stateless service: ${service}`);
for (const dependency of [
  'database-ha',
  'redis-ha',
  'object-storage-replication',
  'secret-provider',
])
  if (!contract.externalDependencies.includes(dependency))
    fail(`missing external dependency: ${dependency}`);
console.log(
  'DR contract passed: active/standby, RPO <= 5m, RTO <= 15m, fenced and smoke-gated failover.',
);
