import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const PORTABLE_FORMAT = 'handstack-portable-v1' as const;

export type PortableScalar = boolean | number | string | null;
// Recursive JSON objects cannot be expressed with Record without a circular alias.
export interface PortableObject {
  readonly [key: string]: PortableValue;
}
export type PortableValue = PortableScalar | PortableValue[] | PortableObject;

export interface PortableRecord {
  readonly repository: string;
  readonly tenantId: string;
  readonly id: string;
  readonly version: number;
  readonly value: Readonly<Record<string, PortableValue>>;
}

export interface PortableManifest {
  readonly format: typeof PORTABLE_FORMAT;
  readonly createdAt: string;
  readonly exportId: string;
  readonly scope: { readonly tenantId?: string };
  readonly repositories: Readonly<
    Record<string, { readonly count: number; readonly checksum: string }>
  >;
  readonly recordCount: number;
  readonly checksumAlgorithm: 'sha256';
  readonly logicalIndexes: readonly PortableValue[];
  readonly pluginSchemas: readonly PortableValue[];
  readonly storageManifest: readonly PortableValue[];
  readonly versions: Readonly<Record<string, string>>;
  readonly signature?: { readonly algorithm: 'hmac-sha256'; readonly value: string };
}

export type PortableFrame =
  | { readonly type: 'record'; readonly sequence: number; readonly record: PortableRecord }
  | { readonly type: 'manifest'; readonly manifest: PortableManifest };

export interface PortableSourceMetadata {
  readonly logicalIndexes?: readonly PortableValue[];
  readonly pluginSchemas?: readonly PortableValue[];
  readonly storageManifest?: readonly PortableValue[];
  readonly versions?: Readonly<Record<string, string>>;
}

export interface PortableSource {
  records(scope: { readonly tenantId?: string }): AsyncIterable<PortableRecord>;
  metadata(): Promise<PortableSourceMetadata>;
}

export interface PortableImportSession {
  stage(record: PortableRecord, sequence: number): Promise<void>;
  checkpoint(sequence: number): Promise<void>;
  commit(manifest: PortableManifest): Promise<void>;
  rollback(): Promise<void>;
}

export interface PortableSink {
  begin(exportId: string, resumeFrom: number): Promise<PortableImportSession>;
  resumeSequence(exportId: string): Promise<number>;
}

export interface PortableExportOptions {
  readonly exportId: string;
  readonly createdAt?: Date;
  readonly tenantId?: string;
  readonly signingKey: string;
}

interface MutableDigest {
  count: number;
  readonly hash: ReturnType<typeof createHash>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

function canonicalRecord(record: PortableRecord): string {
  return canonical(record);
}

function sign(manifest: PortableManifest, key: string): string {
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'signature'),
  );
  return createHmac('sha256', key).update(canonical(unsigned)).digest('hex');
}

function assertRecord(record: PortableRecord, scope: { readonly tenantId?: string }): void {
  if (!/^[a-z][a-z0-9-]*$/.test(record.repository)) throw new Error('Invalid repository name');
  if (record.tenantId.length === 0 || record.id.length === 0) throw new Error('Missing identity');
  if (!Number.isSafeInteger(record.version) || record.version < 1)
    throw new Error('Invalid version');
  if (scope.tenantId !== undefined && record.tenantId !== scope.tenantId) {
    throw new Error('Portable source violated tenant scope');
  }
  const serialized = canonicalRecord(record).toLowerCase();
  if (/"(password|secret|token|api[-_]?key|private[-_]?key)"\s*:/.test(serialized)) {
    throw new Error('Portable export contains a secret field');
  }
}

export async function* exportPortable(
  source: PortableSource,
  options: PortableExportOptions,
): AsyncGenerator<PortableFrame> {
  if (options.signingKey.length < 16) throw new Error('Portable signing key is too short');
  const scope = options.tenantId === undefined ? {} : { tenantId: options.tenantId };
  const digests = new Map<string, MutableDigest>();
  let sequence = 0;
  for await (const record of source.records(scope)) {
    assertRecord(record, scope);
    sequence += 1;
    const digest = digests.get(record.repository) ?? { count: 0, hash: createHash('sha256') };
    digest.count += 1;
    digest.hash.update(canonicalRecord(record)).update('\n');
    digests.set(record.repository, digest);
    yield { type: 'record', sequence, record };
  }
  const metadata = await source.metadata();
  const repositories = Object.fromEntries(
    [...digests.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, digest]) => [
        name,
        { count: digest.count, checksum: digest.hash.digest('hex') },
      ]),
  );
  let manifest: PortableManifest = {
    format: PORTABLE_FORMAT,
    createdAt: (options.createdAt ?? new Date()).toISOString(),
    exportId: options.exportId,
    scope,
    repositories,
    recordCount: sequence,
    checksumAlgorithm: 'sha256',
    logicalIndexes: metadata.logicalIndexes ?? [],
    pluginSchemas: metadata.pluginSchemas ?? [],
    storageManifest: metadata.storageManifest ?? [],
    versions: metadata.versions ?? {},
  };
  manifest = {
    ...manifest,
    signature: { algorithm: 'hmac-sha256', value: sign(manifest, options.signingKey) },
  };
  yield { type: 'manifest', manifest };
}

export interface PortableVerification {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly manifest?: PortableManifest;
}

export async function verifyPortable(
  frames: AsyncIterable<PortableFrame>,
  signingKey: string,
): Promise<PortableVerification> {
  const digests = new Map<string, MutableDigest>();
  const errors: string[] = [];
  let expectedSequence = 1;
  let manifest: PortableManifest | undefined;
  for await (const frame of frames) {
    if (frame.type === 'manifest') {
      if (manifest !== undefined) errors.push('Multiple manifests');
      manifest = frame.manifest;
      continue;
    }
    if (manifest !== undefined) errors.push('Record found after manifest');
    if (frame.sequence !== expectedSequence)
      errors.push(`Expected sequence ${String(expectedSequence)}`);
    expectedSequence = frame.sequence + 1;
    try {
      assertRecord(frame.record, {});
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Invalid record');
    }
    const digest = digests.get(frame.record.repository) ?? { count: 0, hash: createHash('sha256') };
    digest.count += 1;
    digest.hash.update(canonicalRecord(frame.record)).update('\n');
    digests.set(frame.record.repository, digest);
  }
  if (manifest === undefined) return { valid: false, errors: [...errors, 'Missing manifest'] };
  if ((manifest.format as string) !== PORTABLE_FORMAT) errors.push('Unsupported format');
  if (manifest.recordCount !== expectedSequence - 1) errors.push('Record count mismatch');
  for (const [name, digest] of digests) {
    const expected = manifest.repositories[name] as
      { readonly count: number; readonly checksum: string } | undefined;
    const actualChecksum = digest.hash.digest('hex');
    if (expected?.count !== digest.count || expected.checksum !== actualChecksum) {
      errors.push(`Repository checksum mismatch: ${name}`);
    }
  }
  if (Object.keys(manifest.repositories).length !== digests.size)
    errors.push('Repository set mismatch');
  if (manifest.signature === undefined) errors.push('Missing signature');
  else {
    const actual = Buffer.from(manifest.signature.value, 'hex');
    const expected = Buffer.from(sign(manifest, signingKey), 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      errors.push('Invalid signature');
  }
  return { valid: errors.length === 0, errors, manifest };
}

export async function importPortable(
  frames: AsyncIterable<PortableFrame>,
  sink: PortableSink,
  exportId: string,
  signingKey: string,
): Promise<PortableManifest> {
  const resumeFrom = await sink.resumeSequence(exportId);
  const session = await sink.begin(exportId, resumeFrom);
  try {
    async function* stagingFrames(): AsyncGenerator<PortableFrame> {
      for await (const frame of frames) {
        if (frame.type === 'record' && frame.sequence > resumeFrom) {
          await session.stage(frame.record, frame.sequence);
          await session.checkpoint(frame.sequence);
        }
        yield frame;
      }
    }
    const verification = await verifyPortable(stagingFrames(), signingKey);
    if (!verification.valid || verification.manifest === undefined) {
      throw new Error(`Portable verification failed: ${verification.errors.join('; ')}`);
    }
    if (verification.manifest.exportId !== exportId) throw new Error('Export identity mismatch');
    await session.commit(verification.manifest);
    return verification.manifest;
  } catch (error) {
    await session.rollback();
    throw error;
  }
}

export interface PortableComparison {
  readonly equal: boolean;
  readonly differences: readonly string[];
}

export function comparePortable(
  left: PortableManifest,
  right: PortableManifest,
): PortableComparison {
  const differences: string[] = [];
  const names = new Set([...Object.keys(left.repositories), ...Object.keys(right.repositories)]);
  for (const name of [...names].sort()) {
    const leftDigest = left.repositories[name];
    const rightDigest = right.repositories[name];
    if (leftDigest?.count !== rightDigest?.count) differences.push(`${name}: count`);
    if (leftDigest?.checksum !== rightDigest?.checksum) differences.push(`${name}: checksum`);
  }
  return { equal: differences.length === 0, differences };
}
