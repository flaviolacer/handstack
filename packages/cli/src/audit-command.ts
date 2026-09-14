import { randomUUID } from 'node:crypto';
import { TamperEvidentAuditSink, type AuditSinkProvider, type AuditSink } from '@handstack/audit';

export interface AuditCommandRuntime {
  readonly sink: AuditSink;
  readonly provider?: AuditSinkProvider;
  signingKey(): string;
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
    await runtime.write(
      output,
      (async function* () {
        await Promise.resolve();
        for (const event of events) yield `${JSON.stringify(event)}\n`;
      })(),
    );
    runtime.output(
      JSON.stringify({ command: 'audit export', tenant: organizationId, count: events.length }),
    );
    await recordAuditOperation(provider, organizationId, 'AUDIT_EXPORTED', 'ALLOW');
    return;
  }
  throw new Error('Usage: handstack audit <verify|export|checkpoint> --tenant <organizationId>');
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
