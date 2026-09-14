/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
import {
  comparePortable,
  exportPortable,
  importPortable,
  type PortableFrame,
  type PortableImportSession,
  type PortableManifest,
  type PortableRecord,
  type PortableSink,
  type PortableSource,
  verifyPortable,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

const records: PortableRecord[] = [
  { repository: 'users', tenantId: 'tenant-a', id: 'u1', version: 1, value: { name: 'Ana' } },
  { repository: 'users', tenantId: 'tenant-a', id: 'u2', version: 2, value: { name: 'Bia' } },
  { repository: 'users', tenantId: 'tenant-b', id: 'u3', version: 1, value: { name: 'Caio' } },
];

function source(items = records): PortableSource {
  return {
    async *records(scope) {
      for (const record of items) {
        if (scope.tenantId === undefined || scope.tenantId === record.tenantId) yield record;
      }
    },
    async metadata() {
      return {
        logicalIndexes: [{ repository: 'users', fields: ['tenantId', 'id'] }],
        pluginSchemas: [{ plugin: 'official', version: 1 }],
        storageManifest: [{ key: 'avatars/u1', version: 'v1' }],
        versions: { core: '0.1.0' },
      };
    },
  };
}

async function collect(iterable: AsyncIterable<PortableFrame>): Promise<PortableFrame[]> {
  const result: PortableFrame[] = [];
  for await (const frame of iterable) result.push(frame);
  return result;
}

async function* stream(frames: readonly PortableFrame[]): AsyncGenerator<PortableFrame> {
  yield* frames;
}

class MemorySink implements PortableSink {
  readonly staged: PortableRecord[] = [];
  checkpoint = 0;
  committed: PortableManifest | undefined;
  rolledBack = false;

  async resumeSequence(): Promise<number> {
    return this.checkpoint;
  }

  async begin(): Promise<PortableImportSession> {
    return {
      stage: async (record) => {
        this.staged.push(record);
      },
      checkpoint: async (sequence) => {
        this.checkpoint = sequence;
      },
      commit: async (manifest) => {
        this.committed = manifest;
      },
      rollback: async () => {
        this.rolledBack = true;
      },
    };
  }
}

describe('portable persistence format', () => {
  it('streams a signed tenant-scoped export and imports a verified round-trip', async () => {
    const frames = await collect(
      exportPortable(source(), {
        exportId: 'export-1',
        tenantId: 'tenant-a',
        signingKey: 'test-signing-key',
        createdAt: new Date('2026-08-31T12:00:00.000Z'),
      }),
    );
    expect(frames.filter((frame) => frame.type === 'record')).toHaveLength(2);
    const verification = await verifyPortable(stream(frames), 'test-signing-key');
    expect(verification).toMatchObject({ valid: true, errors: [] });
    await expect(verifyPortable(stream(frames), 'wrong-signing-key')).resolves.toMatchObject({
      valid: false,
      errors: ['Invalid signature'],
    });

    const sink = new MemorySink();
    const manifest = await importPortable(stream(frames), sink, 'export-1', 'test-signing-key');
    expect(sink.staged).toEqual(records.slice(0, 2));
    expect(sink.committed).toEqual(manifest);
    expect(manifest).toMatchObject({ recordCount: 2, versions: { core: '0.1.0' } });
  });

  it('rolls back staged data when record tampering is detected', async () => {
    const frames = await collect(
      exportPortable(source(), { exportId: 'export-2', signingKey: 'test-signing-key' }),
    );
    const first = frames[0];
    if (first?.type !== 'record') throw new Error('Expected a record');
    frames[0] = { ...first, record: { ...first.record, value: { name: 'Mallory' } } };
    const sink = new MemorySink();
    await expect(
      importPortable(stream(frames), sink, 'export-2', 'test-signing-key'),
    ).rejects.toThrow('Repository checksum mismatch');
    expect(sink.rolledBack).toBe(true);
    expect(sink.committed).toBeUndefined();
  });

  it('resumes after the durable checkpoint without staging records twice', async () => {
    const frames = await collect(
      exportPortable(source(), { exportId: 'export-3', signingKey: 'test-signing-key' }),
    );
    const sink = new MemorySink();
    sink.checkpoint = 1;
    await importPortable(stream(frames), sink, 'export-3', 'test-signing-key');
    expect(sink.staged.map((record) => record.id)).toEqual(['u2', 'u3']);
    expect(sink.checkpoint).toBe(3);
  });

  it('rejects secret fields and tenant scope violations', async () => {
    const secret = { ...records[0]!, value: { apiKey: 'plaintext' } };
    await expect(
      collect(
        exportPortable(source([secret]), { exportId: 'secret', signingKey: 'test-signing-key' }),
      ),
    ).rejects.toThrow('secret field');
    const violatingSource: PortableSource = {
      async *records() {
        yield records[2]!;
      },
      async metadata() {
        return {};
      },
    };
    await expect(
      collect(
        exportPortable(violatingSource, {
          exportId: 'scope',
          tenantId: 'tenant-a',
          signingKey: 'test-signing-key',
        }),
      ),
    ).rejects.toThrow('tenant scope');
  });

  it('compares canonical repository counts and checksums', async () => {
    const left = await collect(
      exportPortable(source(), { exportId: 'left', signingKey: 'test-signing-key' }),
    );
    const right = await collect(
      exportPortable(source(records.slice(0, 2)), {
        exportId: 'right',
        signingKey: 'test-signing-key',
      }),
    );
    const leftManifest = left.at(-1);
    const rightManifest = right.at(-1);
    if (leftManifest?.type !== 'manifest' || rightManifest?.type !== 'manifest') {
      throw new Error('Expected manifests');
    }
    expect(comparePortable(leftManifest.manifest, leftManifest.manifest)).toEqual({
      equal: true,
      differences: [],
    });
    expect(comparePortable(leftManifest.manifest, rightManifest.manifest)).toEqual({
      equal: false,
      differences: ['users: count', 'users: checksum'],
    });
  });
});
