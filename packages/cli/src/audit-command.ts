import { randomUUID } from 'node:crypto';
import {
  createAuditExportManifest,
  verifyAuditExportManifest,
  TamperEvidentAuditSink,
  type AuditExportManifest,
  type AuditSinkProvider,
  type AuditSink,
} from '@handstack/audit';

export interface AuditCommandRuntime {
  readonly sink: AuditSink;
  readonly provider?: AuditSinkProvider;
  signingKey(): string;
  read(path: string): AsyncIterable<string>;
  write(path: string, content: AsyncIterable<string>): Promise<void>;
  output(value: string): void;
}

export async function executeAuditCommand(
  args: readonly string[],
  runtime: AuditCommandRuntime,
): Promise<void> {
  const command = args[0];
  const option = (name: string): string => {
    const index = args.indexOf(name);
    const value = index < 0 ? undefined : args[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Missing required option ${name}`);
    return value;
  };
  const provider = runtime.provider ?? new TamperEvidentAuditSink(runtime.sink);
  const organizationId = option('--tenant');
  if (command === 'verify') {
    const result = await provider.verify({ organizationId });
    runtime.output(JSON.stringify({ command: 'audit verify', ...result }));
    await recordAuditOperation(
      provider,
      organizationId,
      'AUDIT_VERIFIED',
      result.valid ? 'ALLOW' : 'DENY',
    );
    if (!result.valid) throw new Error(`Audit verification failed: ${result.errors.join('; ')}`);
    return;
  }
  if (command === 'checkpoint') {
    const checkpoint = await provider.checkpoint(organizationId, runtime.signingKey());
    runtime.output(JSON.stringify({ command: 'audit checkpoint', ...checkpoint }));
    await recordAuditOperation(provider, organizationId, 'AUDIT_CHECKPOINT_CREATED', 'ALLOW');
    return;
  }
  if (command === 'export') {
    const output = option('--output');
    const events = await runtime.sink.query(organizationId);
    const content = events.map((event) => JSON.stringify(event)).join('\n');
    const ndjson = content.length === 0 ? '' : `${content}\n`;
    await runtime.write(
      output,
      (async function* () {
        await Promise.resolve();
        yield ndjson;
      })(),
    );
    const manifestPath = `${output}.manifest.json`;
    const manifest = createAuditExportManifest(organizationId, events, ndjson);
    await runtime.write(
      manifestPath,
      (async function* () {
        await Promise.resolve();
        yield `${JSON.stringify(manifest, null, 2)}\n`;
      })(),
    );
    runtime.output(
      JSON.stringify({
        command: 'audit export',
        tenant: organizationId,
        count: events.length,
        manifest: manifestPath,
      }),
    );
    await recordAuditOperation(provider, organizationId, 'AUDIT_EXPORTED', 'ALLOW');
    return;
  }
  if (command === 'verify-export') {
    const input = option('--input');
    const manifestPath = option('--manifest');
    let content = '';
    for await (const chunk of runtime.read(input)) content += chunk;
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readAll(runtime.read(manifestPath)));
    } catch (error) {
      throw new Error(`Audit export manifest is invalid: ${errorMessage(error)}`);
    }
    if (!isAuditExportManifest(manifest))
      throw new Error('Audit export manifest has invalid shape');
    const result =
      manifest.organizationId === organizationId
        ? verifyAuditExportManifest(manifest, content)
        : {
            valid: false,
            errors: [`Manifest organization does not match tenant ${organizationId}`],
          };
    runtime.output(JSON.stringify({ command: 'audit verify-export', ...result }));
    await recordAuditOperation(
      provider,
      organizationId,
      'AUDIT_EXPORT_VERIFIED',
      result.valid ? 'ALLOW' : 'DENY',
    );
    if (!result.valid)
      throw new Error(`Audit export verification failed: ${result.errors.join('; ')}`);
    return;
  }
  throw new Error(
    'Usage: handstack audit <verify|export|verify-export|checkpoint> --tenant <organizationId>',
  );
}

async function readAll(chunks: AsyncIterable<string>): Promise<string> {
  let value = '';
  for await (const chunk of chunks) value += chunk;
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuditExportManifest(value: unknown): value is AuditExportManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const eventCount = candidate.eventCount;
  return (
    candidate.version === 1 &&
    candidate.format === 'ndjson' &&
    typeof candidate.organizationId === 'string' &&
    typeof eventCount === 'number' &&
    Number.isSafeInteger(eventCount) &&
    eventCount >= 0 &&
    typeof candidate.contentSha256 === 'string' &&
    typeof candidate.generatedAt === 'string'
  );
}

async function recordAuditOperation(
  provider: AuditSinkProvider,
  organizationId: string,
  action: string,
  decision: 'ALLOW' | 'DENY',
): Promise<void> {
  await provider.append({
    id: randomUUID(),
    timestamp: new Date(),
    organizationId,
    actorId: 'handstack-cli',
    actorType: 'SYSTEM',
    action,
    resourceType: 'audit',
    decision,
  });
}
