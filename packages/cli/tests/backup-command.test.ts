/* eslint-disable @typescript-eslint/require-await */
import type { PortableImportSession, PortableRecord, PortableSink } from '@handstack/database';
import { executeBackupCommand, type BackupCommandRuntime } from '../src/index.js';
import { describe, expect, it } from 'vitest';

const record: PortableRecord = {
  repository: 'users',
  tenantId: 'tenant-a',
  id: 'user-1',
  version: 1,
  value: { name: 'Ana' },
};

class Sink implements PortableSink {
  readonly records: PortableRecord[] = [];
  async resumeSequence(): Promise<number> {
    return 0;
  }
  async begin(): Promise<PortableImportSession> {
    return {
      stage: async (value) => {
        this.records.push(value);
      },
      checkpoint: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
    };
  }
}

function runtime(): BackupCommandRuntime & { files: Map<string, string>; sink: Sink } {
  const files = new Map<string, string>();
  const sink = new Sink();
  const source = {
    async *records() {
      yield record;
    },
    async metadata() {
      return {};
    },
  };
  return {
    files,
    sink,
    source,
    adapter: 'sqlite',
    signingKey: () => 'backup-signing-key-123',
    async *read(path) {
      yield* (files.get(path) ?? '').split(/\r?\n/);
    },
    async write(path, content) {
      let value = '';
      for await (const chunk of content) value += chunk;
      files.set(path, value);
    },
    output: () => undefined,
  };
}

describe('backup CLI commands', () => {
  it('creates and restores a signed portable backup', async () => {
    const current = runtime();
    await executeBackupCommand(
      ['backup', '--output', 'backup.ndjson', '--export-id', 'backup-1'],
      current,
    );
    const backup = current.files.get('backup.ndjson') ?? '';
    expect(backup).toContain('handstack-backup-v1');
    const header = JSON.parse(backup.split('\n', 1)[0] ?? '{}') as {
      database?: {
        adapter?: string;
        version?: string;
        schemaVersion?: string;
        logicalIndexes?: unknown[];
        pluginSchemas?: unknown[];
        storageManifest?: unknown[];
      };
      configuration?: { secretPolicy?: string };
    };
    expect(header.database).toMatchObject({
      adapter: 'sqlite',
      version: 'unknown',
      schemaVersion: 'unknown',
      logicalIndexes: [],
      pluginSchemas: [],
      storageManifest: [],
    });
    expect(header.configuration?.secretPolicy).toBe('external-encrypted');
    await executeBackupCommand(
      ['restore', '--input', 'backup.ndjson', '--export-id', 'backup-1'],
      current,
    );
    expect(current.sink.records).toEqual([record]);
  });

  it('rejects a backup created for another adapter before staging', async () => {
    const current = runtime();
    await executeBackupCommand(
      ['backup', '--output', 'backup.ndjson', '--export-id', 'backup-1'],
      current,
    );
    const other = runtime();
    other.files.set('backup.ndjson', current.files.get('backup.ndjson') ?? '');
    other.adapter = 'mongodb';
    await expect(
      executeBackupCommand(
        ['restore', '--input', 'backup.ndjson', '--export-id', 'backup-1'],
        other,
      ),
    ).rejects.toThrow('incompatible');
    expect(other.sink.records).toHaveLength(0);
  });

  it('rejects an incomplete metadata header before staging', async () => {
    const current = runtime();
    current.files.set(
      'incomplete.ndjson',
      `${JSON.stringify({
        type: 'backup',
        format: 'handstack-backup-v1',
        schemaVersion: '1',
        adapter: 'sqlite',
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    await expect(
      executeBackupCommand(
        ['restore', '--input', 'incomplete.ndjson', '--export-id', 'backup-1'],
        current,
      ),
    ).rejects.toThrow('Invalid backup header');
    expect(current.sink.records).toHaveLength(0);
  });
});
