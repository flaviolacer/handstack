import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const CORE_GATES = [
  ['format-check', ['run', 'format:check']],
  ['docs-validate', ['run', 'docs:validate']],
  ['lint', ['run', 'lint']],
  ['typecheck', ['run', 'typecheck']],
  ['test', ['test']],
  ['build', ['run', 'build']],
  ['openapi-validate', ['run', 'openapi:validate']],
  ['scope-audit', ['run', 'scope:audit']],
  ['release-validate', ['run', 'release:validate']],
];

const CONTRACT_GATES = [
  ['resilience-validate', ['run', 'resilience:validate']],
  ['dr-validate', ['run', 'dr:validate']],
  ['container-validate', ['run', 'container:validate']],
  ['security-validate', ['run', 'security:validate']],
  ['observability-validate', ['run', 'observability:validate']],
  ['integration-validate', ['run', 'integration:validate']],
  ['helm-validate', ['run', 'helm:validate']],
  ['kubernetes-validate', ['run', 'kubernetes:validate']],
  ['helm-release-validate', ['run', 'helm:release:validate']],
  ['frontend-validate', ['run', 'frontend:validate']],
];

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: npm run certification:preflight [-- --output <directory> --include-contracts]',
  );
  process.exit(0);
}

const includeContracts = args.includes('--include-contracts');
const output = option(args, '--output') ?? `artifacts/certification/local-${timestamp()}`;
const outputDirectory = resolve(root, output);
await mkdir(outputDirectory, { recursive: true });

const gates = includeContracts ? [...CORE_GATES, ...CONTRACT_GATES] : CORE_GATES;
const results = [];
for (const [name, commandArgs] of gates) {
  const startedAt = new Date();
  const started = Date.now();
  const result = await execute(name, commandArgs);
  const finishedAt = new Date();
  const logPath = `${name}.log`;
  await writeFile(resolve(outputDirectory, logPath), result.output, 'utf8');
  results.push({
    name,
    command: `${npmCommand} ${commandArgs.join(' ')}`,
    status: result.code === 0 ? 'PASS' : 'FAIL',
    exitCode: result.code,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Date.now() - started,
    log: logPath,
  });
}
const dockerProbe = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}']);
const environmentProbe = {
  docker: {
    available: dockerProbe.code === 0,
    ...(dockerProbe.code === 0 ? { serverVersion: dockerProbe.output.trim() } : {}),
  },
  redis: {
    testUrlConfigured:
      typeof process.env.HANDSTACK_TEST_REDIS_URL === 'string' &&
      process.env.HANDSTACK_TEST_REDIS_URL.trim() !== '',
  },
};

const manifest = {
  schemaVersion: 1,
  kind: 'handstack-local-certification-preflight',
  generatedAt: new Date().toISOString(),
  sourceRevision: await gitRevision(),
  workingTree: {
    dirty: (await gitStatus()) !== '',
    releaseReviewRequired: true,
  },
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    probes: environmentProbe,
  },
  gates: results,
  externalCertification: {
    status: 'NOT_CERTIFIED',
    reason:
      'Local gates prove repository preparation only; HA/DR/capacity/rollback/providers/pentest require the evidence defined in CERTIFICATION-READINESS.md.',
  },
};
await writeFile(
  resolve(outputDirectory, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);
const gateTable = results
  .map(
    (result) =>
      `| ${result.name} | ${result.status} | \`${result.command}\` | [${result.log}](./${result.log}) |`,
  )
  .join('\n');
const reproductionCommand = `npm run certification:preflight -- --output ${output}${
  includeContracts ? ' --include-contracts' : ''
}`;
const readme = `# HandStack local certification preflight

Generated at: ${manifest.generatedAt}

This package proves repository preparation only. External certification remains **NOT_CERTIFIED**
until the environment, provider and independent-review evidence described in
[\`CERTIFICATION-READINESS.md\`](../../../CERTIFICATION-READINESS.md) is attached.

## Reproduction

Run from the repository root:

\`\`\`text
${reproductionCommand}
\`\`\`

The source revision was \`${manifest.sourceRevision}\`; the working tree was marked
\`${String(manifest.workingTree.dirty)}\`. Review the revision and local changes before using this
package as a release candidate.

## Environment snapshot

- Docker daemon available: **${String(environmentProbe.docker.available)}**${
  environmentProbe.docker.serverVersion === undefined
    ? ''
    : ` (server ${environmentProbe.docker.serverVersion})`
}
- Redis integration URL configured: **${String(environmentProbe.redis.testUrlConfigured)}**

This snapshot is informational and does not promote any external certification gate. URLs,
credentials and secret values are intentionally omitted.

## Local gates

| Gate | Status | Command | Log |
| --- | --- | --- | --- |
${gateTable}

## External evidence still required

- database HA/failover and backup/restore;
- multi-zone or multi-region DR with measured RPO/RTO;
- capacity results with p95/p99 and resource topology;
- zero-downtime upgrade and rollback;
- authorized external-provider E2E runs;
- independent threat-model review and penetration-test retest.

Do not place credentials, user content, prompts, model responses or secret material in this package.
Use redacted IDs and the evidence directories specified by \`CERTIFICATION-READINESS.md\`.
`;
await writeFile(resolve(outputDirectory, 'README.md'), readme, 'utf8');
console.log(`Local certification evidence written to ${outputDirectory}`);
if (results.some((result) => result.status === 'FAIL')) process.exitCode = 1;

function option(values, name) {
  const index = values.indexOf(name);
  const value = index < 0 ? undefined : values[index + 1];
  if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`);
  return value;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

async function execute(name, commandArgs) {
  process.stdout.write(`Running ${name}...\n`);
  return runProcess(npmCommand, commandArgs);
}

async function gitRevision() {
  const result = await runProcess('git', ['rev-parse', 'HEAD']);
  return result.code === 0 ? result.output.trim() : 'working-tree';
}

async function gitStatus() {
  const result = await runProcess('git', ['status', '--porcelain']);
  return result.code === 0 ? result.output : 'unavailable';
}

function runProcess(command, commandArgs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, commandArgs, {
        cwd: root,
        env: process.env,
        windowsHide: true,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        code: 1,
        output: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      return;
    }
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.once('error', (error) => {
      output += error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`;
    });
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}
