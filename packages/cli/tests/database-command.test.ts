/* eslint-disable @typescript-eslint/require-await */
import type {
  PortableImportSession,
  PortableManifest,
  PortableRecord,
  PortableSink,
  PortableSource,
} from '@handstack/database';
import { executeDatabaseCommand, type DatabaseCommandRuntime } from '../src/index.js';
import { describe, expect, it } from 'vitest';

const signingKey = 'test-portable-signing-key';
const record: PortableRecord = {
  repository: 'users',
  tenantId: 'tenant-a',
  id: 'user-1',
  version: 1,
  value: { name: 'Ana' },
};

class MemorySink implements PortableSink {
  readonly records: PortableRecord[] = [];
  committed: PortableManifest | undefined;
  async resumeSequence(): Promise<number> {
    return 0;
  }
  async begin(): Promise<PortableImportSession> {
    return {
      stage: async (value) => {
        this.records.push(value);
      },
      checkpoint: async () => undefined,
      commit: async (manifest) => {
        this.committed = manifest;
      },
      rollback: async () => undefined,
    };
  }
}

function createRuntime(): DatabaseCommandRuntime & {
  files: Map<string, string>;
  outputs: string[];
  sink: MemorySink;
} {
  const files = new Map<string, string>();
  const outputs: string[] = [];
  const source: PortableSource = {
    async *records(scope) {
      if (scope.tenantId === undefined || scope.tenantId === record.tenantId) yield record;
    },
    async metadata() {
      return { versions: { core: '0.1.0' } };
    },
  };
  const sink = new MemorySink();
  return {
    files,
    outputs,
    source,
    sink,
    signingKey: () => signingKey,
    async *read(path) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`Missing file ${path}`);
      yield* content.split(/\r?\n/);
    },
    async write(path, content) {
      let result = '';
      for await (const chunk of content) result += chunk;
      files.set(path, result);
    },
    output(value) {
      outputs.push(value);
    },
  };
}

describe('database CLI commands', () => {
  it('exports, verifies, imports, and compares portable NDJSON', async () => {
    const runtime = createRuntime();
    await executeDatabaseCommand(
      [
        'export',
        '--portable',
        '--output',
        'one.ndjson',
        '--export-id',
        'export-1',
        '--tenant',
        'tenant-a',
      ],
      runtime,
    );
    expect(runtime.files.get('one.ndjson')).toContain('"type":"manifest"');
    await executeDatabaseCommand(['verify', '--input', 'one.ndjson'], runtime);
    await executeDatabaseCommand(
      ['import', '--portable', '--input', 'one.ndjson', '--export-id', 'export-1'],
      runtime,
    );
    runtime.files.set('two.ndjson', runtime.files.get('one.ndjson') ?? '');
    await executeDatabaseCommand(
      ['compare', '--left', 'one.ndjson', '--right', 'two.ndjson'],
      runtime,
    );
    expect(runtime.sink.records).toEqual([record]);
    expect(runtime.sink.committed?.recordCount).toBe(1);
    expect(runtime.outputs).toContain('Portable exports match');
  });

  it('rejects invalid NDJSON and missing required options', async () => {
    const runtime = createRuntime();
    runtime.files.set('invalid.ndjson', '{bad json}\n');
    await expect(
      executeDatabaseCommand(['verify', '--input', 'invalid.ndjson'], runtime),
    ).rejects.toThrow('Invalid portable NDJSON');
    await expect(executeDatabaseCommand(['verify'], runtime)).rejects.toThrow(
      'Missing required option --input',
    );
    await expect(executeDatabaseCommand(['export'], runtime)).rejects.toThrow(
      'Export requires --portable',
    );
  });

  it('reports comparison divergence with a non-successful command', async () => {
    const runtime = createRuntime();
    await executeDatabaseCommand(
      ['export', '--portable', '--output', 'left.ndjson', '--export-id', 'left'],
      runtime,
    );
    const differentRuntime = createRuntime();
    const differentSource: PortableSource = {
      async *records() {
        for (const item of [] as PortableRecord[]) yield item;
      },
      async metadata() {
        return {};
      },
    };
    Object.defineProperty(differentRuntime, 'source', { value: differentSource });
    await executeDatabaseCommand(
      ['export', '--portable', '--output', 'right.ndjson', '--export-id', 'right'],
      differentRuntime,
    );
    runtime.files.set('right.ndjson', differentRuntime.files.get('right.ndjson') ?? '');
    await expect(
      executeDatabaseCommand(
        ['compare', '--left', 'left.ndjson', '--right', 'right.ndjson'],
        runtime,
      ),
    ).rejects.toThrow('Portable exports differ');
    expect(runtime.outputs.at(-1)).toContain('users: count');
  });
});
