import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const reportPath = resolve(root, 'docs/operations/capacity-report-0.1.md');
const report = readFileSync(reportPath, 'utf8');
const requiredMarkers = [
  'profile: compact',
  'profile: distributed',
  'availability: 99.9%',
  'api_p95_ms: 300',
  'queue_wait_p95_seconds: 5',
  'accepted_durable_job_loss: 0',
];
const missing = requiredMarkers.filter((marker) => !report.includes(marker));
if (missing.length > 0) {
  console.error(`Capacity report is missing: ${missing.join(', ')}`);
  process.exit(1);
}

const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['--workspace', '@handstack/jobs', 'test', '--', 'tests/resilience.test.ts'],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Offline resilience gate passed: bounded spike, idempotency and DLQ retention.');
