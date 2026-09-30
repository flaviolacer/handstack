#!/usr/bin/env node
import { executeDatabaseCommand } from './database-command.js';
import { createFileRuntime } from './file-runtime.js';
import { configLayerFromEnvironment, resolveConfigLayers } from '@handstack/config';
import {
  createDatabaseAdapter,
  createPortableSink,
  createPortableSource,
} from '@handstack/database';
import { executeDoctorCommand, executeMigrateCommand } from './operational-command.js';
import { executeBackupCommand } from './backup-command.js';
import { executeAuditCommand } from './audit-command.js';
import { RepositoryAuditSink, TamperEvidentAuditSink } from '@handstack/audit';
import { executeApplyCommand } from './apply-command.js';
import { executeAdminCommand } from './admin-command.js';
import { executeInitCommand } from './init-command.js';
import { executeExportCommand } from './export-command.js';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { executeConfigSyncCommand } from './sync-command.js';
import { executeConfigValidateCommand } from './config-command.js';
import { loadConfigFile } from './config-file.js';
import { requiredPortableSigningKey } from './runtime-config.js';

const output = (value: string): void => {
  process.stdout.write(`${value}\n`);
};

function effectiveConfig() {
  return resolveConfigLayers(configLayerFromEnvironment(process.env), loadConfigFile());
}

async function main(): Promise<void> {
  const [group, ...args] = process.argv.slice(2);
  if (group === 'init') {
    await executeInitCommand([group, ...args], {
      write: (path, content) => createFileRuntime(process.env).write(path, content),
      output,
    });
    return;
  }
  if (group === 'start') {
    if (args.length > 0) throw new Error('Usage: handstack start');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], {
        stdio: 'inherit',
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (signal !== null) reject(new Error(`Development process terminated by ${signal}`));
        else if (code === 0) resolve();
        else reject(new Error(`Development process exited with code ${String(code)}`));
      });
    });
    return;
  }
  if (group === 'audit') {
    const config = effectiveConfig();
    const adapter = createDatabaseAdapter(config);
    await adapter.initialize();
    try {
      const sink = new RepositoryAuditSink((name) => adapter.repository(name));
      await executeAuditCommand(args, {
        sink,
        provider: new TamperEvidentAuditSink(sink),
        signingKey() {
          return requiredPortableSigningKey();
        },
        write(path, content) {
          return createFileRuntime(process.env).write(path, content);
        },
        read(path) {
          return createFileRuntime(process.env).read(path);
        },
        output,
      });
    } finally {
      await adapter.close();
    }
    return;
  }
  if (group === 'backup' || group === 'restore') {
    const adapter = createDatabaseAdapter(effectiveConfig());
    await adapter.initialize();
    try {
      await executeBackupCommand(args.length === 0 ? [group] : [group, ...args], {
        adapter: effectiveConfig().database.adapter,
        ...(group === 'backup'
          ? { source: createPortableSource(adapter) }
          : { sink: createPortableSink(adapter) }),
        signingKey() {
          return requiredPortableSigningKey();
        },
        read(path) {
          return createFileRuntime(process.env).read(path);
        },
        write(path, content) {
          return createFileRuntime(process.env).write(path, content);
        },
        output,
      });
    } finally {
      await adapter.close();
    }
    return;
  }
  if (group === 'migrate' || group === 'doctor') {
    if (args.length > 0) throw new Error(`Usage: handstack ${group}`);
    const adapter = createDatabaseAdapter(effectiveConfig());
    await adapter.initialize();
    try {
      if (group === 'migrate') await executeMigrateCommand(adapter, { output });
      else await executeDoctorCommand(adapter, { output });
    } finally {
      await adapter.close();
    }
    return;
  }
  if (group === 'apply') {
    await executeApplyCommand([group, ...args], {
      async read(path) {
        const lines: string[] = [];
        for await (const line of createFileRuntime(process.env).read(path)) lines.push(line);
        return lines.join('\n');
      },
      output,
      request: (url, init) => fetch(url, init),
    });
    return;
  }
  if (group === 'export') {
    await executeExportCommand([group, ...args], {
      request: (url, init) => fetch(url, init),
      write(path, content) {
        return createFileRuntime(process.env).write(
          path,
          (async function* () {
            await Promise.resolve();
            yield content;
          })(),
        );
      },
      output,
    });
    return;
  }
  if (group === 'config' && args[0] === 'sync') {
    await executeConfigSyncCommand([group, ...args], {
      async verifyRef(repository, ref) {
        await git(repository, ['rev-parse', '--verify', `${ref}^{commit}`]);
      },
      readAtRef(repository, ref, path) {
        return git(repository, ['show', `${ref}:${path}`]);
      },
      request: (url, init) => fetch(url, init),
      output,
    });
    return;
  }
  if (group === 'config' && args[0] === 'validate') {
    executeConfigValidateCommand([group, ...args], effectiveConfig(), { output });
    return;
  }
  if (
    group === 'user' ||
    group === 'agent' ||
    group === 'capability' ||
    group === 'plugin' ||
    group === 'mcp'
  ) {
    await executeAdminCommand([group, ...args], {
      request: (url, init) => fetch(url, init),
      output,
    });
    return;
  }
  if (group !== 'database')
    throw new Error(
      'Usage: handstack <migrate|doctor|apply|export|config <validate|sync>|database <command>>',
    );
  const fileRuntime = createFileRuntime(process.env);
  if (!['export', 'import'].includes(args[0] ?? '')) {
    await executeDatabaseCommand(args, fileRuntime);
    return;
  }
  const adapter = createDatabaseAdapter(effectiveConfig());
  await adapter.initialize();
  try {
    await executeDatabaseCommand(args, {
      ...fileRuntime,
      ...(args[0] === 'export'
        ? { source: createPortableSource(adapter) }
        : { sink: createPortableSink(adapter) }),
    });
  } finally {
    await adapter.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Unknown CLI error'}\n`);
  process.exitCode = 1;
});

function git(repository: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repository, ...args],
      { encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`Git command failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
