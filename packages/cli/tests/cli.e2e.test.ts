import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const cliSource = resolve(testDirectory, '../src/bin.ts');
const tsxCli = resolve(testDirectory, '../../../node_modules/tsx/dist/cli.mjs');

async function runCli(
  cwd: string,
  args: readonly string[],
  environment: Record<string, string>,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return execFileAsync(process.execPath, [tsxCli, cliSource, ...args], {
    cwd,
    env: {
      ...process.env,
      NODE_PATH: resolve(testDirectory, '../../../node_modules'),
      ...environment,
    },
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

describe('HandStack CLI process journey', () => {
  it('runs init, apply, export and config sync against an authenticated API', async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), 'handstack-cli-e2e-'));
    const requests: { method: string; path: string; body: string }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({
          method: request.method ?? 'GET',
          path: request.url ?? '/',
          body,
        });
        response.setHeader('content-type', 'application/json');
        if (request.method === 'GET') {
          const items = request.url?.includes('/agents')
            ? [{ slug: 'reviewer', name: 'Reviewer', token: 'must-not-export' }]
            : [{ name: 'support-read', secret: 'must-not-export' }];
          response.end(JSON.stringify({ items }));
          return;
        }
        response.statusCode = 201;
        response.end(JSON.stringify({ id: 'created' }));
      });
    });

    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Server address missing');
      const apiUrl = `http://127.0.0.1:${String(address.port)}`;
      const environment = {
        HANDSTACK_API_URL: apiUrl,
        HANDSTACK_ORGANIZATION_ID: 'org-a',
        HANDSTACK_ACCESS_TOKEN: 'token-a',
      };

      const initialized = await runCli(workspace, ['init'], environment);
      expect(initialized.stdout).toContain('Created handstack.config.ts');
      expect(readFileSync(resolve(workspace, 'handstack.config.ts'), 'utf8')).toContain(
        "adapter: 'sqlite'",
      );

      const manifest = `- apiVersion: handstack.io/v1\n  kind: Group\n  metadata:\n    name: Engineering\n  spec:\n    name: Engineering\n`;
      const manifestPath = resolve(workspace, 'manifest.yaml');
      writeFileSync(manifestPath, manifest, 'utf8');
      const applied = await runCli(workspace, ['apply', '-f', manifestPath], environment);
      expect(applied.stdout).toContain('Applied Group/Engineering');

      const exportedPath = resolve(workspace, 'export.yaml');
      const exported = await runCli(
        workspace,
        ['export', '--resource', 'Agent,Policy', '-o', exportedPath],
        environment,
      );
      expect(exported.stdout).toContain('Configuration export written');
      const exportedContent = readFileSync(exportedPath, 'utf8');
      expect(exportedContent).toContain('kind: Agent');
      expect(exportedContent).toContain('reviewer');
      expect(exportedContent).not.toContain('must-not-export');

      execFileSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true });
      execFileSync('git', ['config', 'user.email', 'handstack-e2e@example.test'], {
        cwd: workspace,
        windowsHide: true,
      });
      execFileSync('git', ['config', 'user.name', 'HandStack E2E'], {
        cwd: workspace,
        windowsHide: true,
      });
      execFileSync('git', ['add', 'manifest.yaml'], { cwd: workspace, windowsHide: true });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: workspace, windowsHide: true });

      const synchronized = await runCli(
        workspace,
        ['config', 'sync', '--repo', workspace, '--ref', 'HEAD', '-f', 'manifest.yaml'],
        environment,
      );
      expect(synchronized.stdout).toContain('Configuration synchronized');
      expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2);
      expect(requests.some((request) => request.path.endsWith('/groups'))).toBe(true);
    } finally {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error === undefined) resolveClose();
          else reject(error);
        });
      });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it('runs migrate, doctor, signed backup and restore with SQLite', async () => {
    const workspace = mkdtempSync(resolve(tmpdir(), 'handstack-cli-persistence-e2e-'));
    const environment = {
      HANDSTACK_PORTABLE_SIGNING_KEY: 'portable-signing-key-for-e2e',
    };

    try {
      await runCli(workspace, ['init'], environment);
      const migrated = await runCli(workspace, ['migrate'], environment);
      expect(migrated.stdout).toContain('"command":"migrate"');
      const diagnosed = await runCli(workspace, ['doctor'], environment);
      expect(diagnosed.stdout).toContain('"command":"doctor"');

      const backup = await runCli(
        workspace,
        ['backup', '--output', 'backup.ndjson', '--export-id', 'sqlite-e2e-1'],
        environment,
      );
      expect(backup.stdout).toContain('Backup written: backup.ndjson');
      expect(readFileSync(resolve(workspace, 'backup.ndjson'), 'utf8')).toContain(
        'handstack-backup-v1',
      );

      const restored = await runCli(
        workspace,
        ['restore', '--input', 'backup.ndjson', '--export-id', 'sqlite-e2e-1'],
        {
          ...environment,
          HANDSTACK_DATABASE_ADAPTER: 'sqlite',
          HANDSTACK_DATABASE_URL: 'file:./restored.db',
        },
      );
      expect(restored.stdout).toContain('Backup restored: 0 records');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
