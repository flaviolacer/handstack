import {
  comparePortable,
  exportPortable,
  importPortable,
  type PortableManifest,
  type PortableSink,
  type PortableSource,
  verifyPortable,
} from '@handstack/database';
import { decodePortableFrames, encodePortableFrames } from './codec.js';

export interface DatabaseCommandRuntime {
  readonly source?: PortableSource;
  readonly sink?: PortableSink;
  signingKey(): string;
  read(path: string): AsyncIterable<string>;
  write(path: string, content: AsyncIterable<string>): Promise<void>;
  output(value: string): void;
}

function option(args: readonly string[], name: string): string;
function option(args: readonly string[], name: string, required: false): string | undefined;
function option(args: readonly string[], name: string, required = true): string | undefined {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (required && (value === undefined || value.startsWith('--'))) {
    throw new Error(`Missing required option ${name}`);
  }
  return value;
}

async function verifiedManifest(
  runtime: DatabaseCommandRuntime,
  path: string,
): Promise<PortableManifest> {
  const result = await verifyPortable(
    decodePortableFrames(runtime.read(path)),
    runtime.signingKey(),
  );
  if (!result.valid || result.manifest === undefined) {
    throw new Error(`Portable verification failed: ${result.errors.join('; ')}`);
  }
  return result.manifest;
}

export async function executeDatabaseCommand(
  args: readonly string[],
  runtime: DatabaseCommandRuntime,
): Promise<void> {
  const command = args[0];
  if (command === 'export') {
    if (!args.includes('--portable')) throw new Error('Export requires --portable');
    if (runtime.source === undefined) throw new Error('Database source is not configured');
    const output = option(args, '--output');
    const exportId = option(args, '--export-id');
    const tenantId = option(args, '--tenant', false);
    const exportOptions =
      tenantId === undefined
        ? { exportId, signingKey: runtime.signingKey() }
        : { exportId, signingKey: runtime.signingKey(), tenantId };
    await runtime.write(
      output,
      encodePortableFrames(exportPortable(runtime.source, exportOptions)),
    );
    runtime.output(`Portable export written: ${output}`);
    return;
  }
  if (command === 'import') {
    if (!args.includes('--portable')) throw new Error('Import requires --portable');
    if (runtime.sink === undefined) throw new Error('Database sink is not configured');
    const input = option(args, '--input');
    const exportId = option(args, '--export-id');
    const manifest = await importPortable(
      decodePortableFrames(runtime.read(input)),
      runtime.sink,
      exportId,
      runtime.signingKey(),
    );
    runtime.output(`Portable import committed: ${String(manifest.recordCount)} records`);
    return;
  }
  if (command === 'verify') {
    const manifest = await verifiedManifest(runtime, option(args, '--input'));
    runtime.output(`Portable export valid: ${String(manifest.recordCount)} records`);
    return;
  }
  if (command === 'compare') {
    const left = await verifiedManifest(runtime, option(args, '--left'));
    const right = await verifiedManifest(runtime, option(args, '--right'));
    const comparison = comparePortable(left, right);
    runtime.output(
      comparison.equal
        ? 'Portable exports match'
        : `Portable exports differ: ${comparison.differences.join(', ')}`,
    );
    if (!comparison.equal) throw new Error('Portable exports differ');
    return;
  }
  throw new Error('Usage: handstack database <export|import|verify|compare>');
}
