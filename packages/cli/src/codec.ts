import {
  PORTABLE_FORMAT,
  type PortableFrame,
  type PortableManifest,
  type PortableRecord,
  type PortableValue,
} from '@handstack/database';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPortableValue(value: unknown): value is PortableValue {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isPortableValue);
  return isObject(value) && Object.values(value).every(isPortableValue);
}

function parseRecord(value: unknown): PortableRecord {
  if (
    !isObject(value) ||
    typeof value.repository !== 'string' ||
    typeof value.tenantId !== 'string' ||
    typeof value.id !== 'string' ||
    typeof value.version !== 'number' ||
    !isObject(value.value) ||
    !isPortableValue(value.value)
  ) {
    throw new Error('Invalid portable record frame');
  }
  return {
    repository: value.repository,
    tenantId: value.tenantId,
    id: value.id,
    version: value.version,
    value: value.value,
  };
}

function parseManifest(value: unknown): PortableManifest {
  if (
    !isObject(value) ||
    value.format !== PORTABLE_FORMAT ||
    typeof value.createdAt !== 'string' ||
    typeof value.exportId !== 'string' ||
    !isObject(value.scope) ||
    !isObject(value.repositories) ||
    typeof value.recordCount !== 'number' ||
    value.checksumAlgorithm !== 'sha256' ||
    !Array.isArray(value.logicalIndexes) ||
    !Array.isArray(value.pluginSchemas) ||
    !Array.isArray(value.storageManifest) ||
    !isObject(value.versions) ||
    !isObject(value.signature) ||
    value.signature.algorithm !== 'hmac-sha256' ||
    typeof value.signature.value !== 'string'
  ) {
    throw new Error('Invalid portable manifest frame');
  }
  return value as unknown as PortableManifest;
}

export function decodePortableFrame(line: string): PortableFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error('Invalid portable NDJSON');
  }
  if (!isObject(parsed)) throw new Error('Invalid portable frame');
  if (parsed.type === 'record' && typeof parsed.sequence === 'number') {
    return { type: 'record', sequence: parsed.sequence, record: parseRecord(parsed.record) };
  }
  if (parsed.type === 'manifest')
    return { type: 'manifest', manifest: parseManifest(parsed.manifest) };
  throw new Error('Invalid portable frame type');
}

export function encodePortableFrame(frame: PortableFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export async function* decodePortableFrames(
  lines: AsyncIterable<string>,
): AsyncGenerator<PortableFrame> {
  for await (const line of lines) {
    if (line.trim().length > 0) yield decodePortableFrame(line);
  }
}

export async function* encodePortableFrames(
  frames: AsyncIterable<PortableFrame>,
): AsyncGenerator<string> {
  for await (const frame of frames) yield encodePortableFrame(frame);
}
