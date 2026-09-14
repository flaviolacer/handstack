import {
  importPortable,
  type PortableSink,
  type PortableSource,
  type PortableValue,
} from '@handstack/database';
import { decodePortableFrame, encodePortableFrame } from './codec.js';

export const BACKUP_FORMAT = 'handstack-backup-v1' as const;

export interface BackupHeader {
  readonly type: 'backup';
  readonly format: typeof BACKUP_FORMAT;
  readonly schemaVersion: string;
  adapter: string;
  readonly createdAt: string;
  readonly database: {
    readonly adapter: string;
    readonly version: string;
    readonly schemaVersion: string;
    readonly logicalIndexes: readonly PortableValue[];
    readonly pluginSchemas: readonly PortableValue[];
    readonly storageManifest: readonly PortableValue[];
  };
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
}

export interface BackupCommandRuntime {
  readonly source?: PortableSource;
  readonly sink?: PortableSink;
  adapter: string;
  signingKey(): string;
  read(path: string): AsyncIterable<string>;
  write(path: string, content: AsyncIterable<string>): Promise<void>;
  output(value: string): void;
}

function encodeHeader(header: BackupHeader): string {
  return `${JSON.stringify(header)}\n`;
}

async function readBackup(lines: AsyncIterable<string>): Promise<{
  header: BackupHeader;
  frames: AsyncIterable<ReturnType<typeof decodePortableFrame>>;
}> {
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error('Backup is empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.value) as unknown;
  } catch {
    throw new Error('Invalid backup header');
  }
  const database =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { database?: Record<string, unknown> }).database
      : undefined;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { type?: unknown }).type !== 'backup' ||
    (parsed as { format?: unknown }).format !== BACKUP_FORMAT ||
    typeof (parsed as { schemaVersion?: unknown }).schemaVersion !== 'string' ||
    typeof (parsed as { adapter?: unknown }).adapter !== 'string' ||
    typeof (parsed as { createdAt?: unknown }).createdAt !== 'string' ||
    database === undefined ||
    database.adapter !== (parsed as { adapter?: unknown }).adapter ||
    typeof database.version !== 'string' ||
    typeof database.schemaVersion !== 'string' ||
    !Array.isArray(database.logicalIndexes) ||
    !Array.isArray(database.pluginSchemas) ||
    !Array.isArray(database.storageManifest)
  ) {
    throw new Error('Invalid backup header');
  }
  const header = parsed as BackupHeader;
  async function* remaining(): AsyncGenerator<string> {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.trim().length > 0) yield next.value;
    }
  }
  return {
    header,
    frames: (async function* () {
      for await (const line of remaining()) yield decodePortableFrame(line);
    })(),
  };
}

export async function executeBackupCommand(
  args: readonly string[],
  runtime: BackupCommandRuntime,
): Promise<void> {
  const command = args[0];
  const option = (name: string): string => {
    const index = args.indexOf(name);
    const value = index < 0 ? undefined : args[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Missing required option ${name}`);
    return value;
  };
  if (command === 'backup') {
    if (runtime.source === undefined) throw new Error('Database source is not configured');
    const output = option('--output');
    const exportId = option('--export-id');
    const sourceMetadata = await runtime.source.metadata();
    const header: BackupHeader = {
      type: 'backup',
      format: BACKUP_FORMAT,
      schemaVersion: '1',
      adapter: runtime.adapter,
      createdAt: new Date().toISOString(),
      database: {
        adapter: runtime.adapter,
        version: sourceMetadata.versions?.adapter ?? 'unknown',
        schemaVersion: sourceMetadata.versions?.persistence ?? 'unknown',
        logicalIndexes: sourceMetadata.logicalIndexes ?? [],
        pluginSchemas: sourceMetadata.pluginSchemas ?? [],
        storageManifest: sourceMetadata.storageManifest ?? [],
      },
      configuration: {
        adapter: runtime.adapter,
        backupFormat: BACKUP_FORMAT,
        secretPolicy: 'external-encrypted',
      },
    };
    const frames = runtime.source;
    await runtime.write(
      output,
      (async function* () {
        yield encodeHeader(header);
        const { exportPortable } = await import('@handstack/database');
        for await (const frame of exportPortable(frames, {
          exportId,
          signingKey: runtime.signingKey(),
        })) {
          yield encodePortableFrame(frame);
        }
      })(),
    );
    runtime.output(`Backup written: ${output}`);
    return;
  }
  if (command === 'restore') {
    if (runtime.sink === undefined) throw new Error('Database sink is not configured');
    const input = option('--input');
    const { header, frames } = await readBackup(runtime.read(input));
    if (header.adapter !== runtime.adapter) {
      throw new Error(`Backup adapter ${header.adapter} is incompatible with ${runtime.adapter}`);
    }
    if (header.schemaVersion !== '1') {
      throw new Error(`Unsupported backup schema version ${header.schemaVersion}`);
    }
    const manifest = await importPortable(
      frames,
      runtime.sink,
      option('--export-id'),
      runtime.signingKey(),
    );
    runtime.output(`Backup restored: ${String(manifest.recordCount)} records`);
    return;
  }
  throw new Error('Usage: handstack <backup|restore>');
}
