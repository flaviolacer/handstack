#!/usr/bin/env node
import { executeDatabaseCommand } from './database-command.js';
import { createFileRuntime } from './file-runtime.js';
import { configFromEnvironment } from '@handstack/config';
import {
  createDatabaseAdapter,
  createPortableSink,
  createPortableSource,
} from '@handstack/database';
import { executeDoctorCommand, executeMigrateCommand } from './operational-command.js';
import { executeBackupCommand } from './backup-command.js';
import { executeAuditCommand } from './audit-command.js';
import { RepositoryAuditSink, TamperEvidentAuditSink } from '@handstack/audit';

const output = (value: string): void => {
  process.stdout.write(`${value}\n`);
};

async function main(): Promise<void> {
  const [group, ...args] = process.argv.slice(2);
  if (group === 'audit') {
    const config = configFromEnvironment(process.env);
    const adapter = createDatabaseAdapter(config);
    await adapter.initialize();
    try {
      const sink = new RepositoryAuditSink((name) => adapter.repository(name));
      await executeAuditCommand(args, {
        sink,
        provider: new TamperEvidentAuditSink(sink),
        signingKey() {
          const key = process.env.HANDSTACK_PORTABLE_SIGNING_KEY;
          if (key === undefined) throw new Error('HANDSTACK_PORTABLE_SIGNING_KEY is required');
          return key;
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
  if (group === 'backup' || group === 'restore') {
    const adapter = createDatabaseAdapter(configFromEnvironment(process.env));
    await adapter.initialize();
    try {
      await executeBackupCommand(args.length === 0 ? [group] : [group, ...args], {
        adapter: configFromEnvironment(process.env).database.adapter,
        ...(group === 'backup'
          ? { source: createPortableSource(adapter) }
          : { sink: createPortableSink(adapter) }),
        signingKey() {
          const key = process.env.HANDSTACK_PORTABLE_SIGNING_KEY;
          if (key === undefined) throw new Error('HANDSTACK_PORTABLE_SIGNING_KEY is required');
          return key;
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
    const adapter = createDatabaseAdapter(configFromEnvironment(process.env));
    await adapter.initialize();
    try {
      if (group === 'migrate') await executeMigrateCommand(adapter, { output });
      else await executeDoctorCommand(adapter, { output });
    } finally {
      await adapter.close();
    }
    return;
  }
  if (group !== 'database') throw new Error('Usage: handstack <migrate|doctor|database <command>>');
  const fileRuntime = createFileRuntime(process.env);
  if (!['export', 'import'].includes(args[0] ?? '')) {
    await executeDatabaseCommand(args, fileRuntime);
    return;
  }
  const adapter = createDatabaseAdapter(configFromEnvironment(process.env));
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
