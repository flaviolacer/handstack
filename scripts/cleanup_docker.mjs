import { execFileSync } from 'node:child_process';

const resourceTypes = [
  ['container', ['ps', '-aq', '--filter', 'name=handstack']],
  ['volume', ['volume', 'ls', '-q', '--filter', 'name=handstack']],
  ['network', ['network', 'ls', '-q', '--filter', 'name=handstack']],
];

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

try {
  docker([
    'compose',
    '-p',
    'handstack',
    '-f',
    'deploy/docker-compose/compose.yaml',
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
  const removed = {};
  for (const [type, listArgs] of resourceTypes) {
    const ids = docker(listArgs).split(/\r?\n/u).filter(Boolean);
    removed[type] = ids;
    if (ids.length > 0) docker([type, 'rm', '-f', ...ids]);
  }
  console.log(JSON.stringify({ status: 'CLEANED', removed }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Docker cleanup unavailable or failed: ${message}`);
  process.exitCode = 2;
}
