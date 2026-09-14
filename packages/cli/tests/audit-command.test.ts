import { InMemoryAuditSink, TamperEvidentAuditSink, type AuditEvent } from '@handstack/audit';
import { executeAuditCommand } from '../src/audit-command.js';
import { describe, expect, it } from 'vitest';

const event: AuditEvent = {
  id: 'event-1',
  timestamp: new Date('2026-01-01T00:00:00Z'),
  organizationId: 'org-a',
  actorId: 'system',
  actorType: 'SYSTEM',
  action: 'CHECK',
  resourceType: 'audit',
  decision: 'ALLOW',
};

function runtime() {
  const sink = new InMemoryAuditSink();
  const files = new Map<string, string>();
  const output: string[] = [];
  return {
    sink,
    provider: new TamperEvidentAuditSink(sink),
    signingKey: () => 'audit-test-key',
    async write(path: string, content: AsyncIterable<string>) {
      let value = '';
      for await (const chunk of content) value += chunk;
      files.set(path, value);
    },
    output(value: string) {
      output.push(value);
    },
    files,
    outputValues: output,
  };
}

describe('audit CLI commands', () => {
  it('verifies and checkpoints the tenant audit chain', async () => {
    const current = runtime();
    await current.provider.append(event);
    await executeAuditCommand(['verify', '--tenant', 'org-a'], current);
    await executeAuditCommand(['checkpoint', '--tenant', 'org-a'], current);
    expect(current.outputValues[0]).toContain('"valid":true');
    expect(current.outputValues[1]).toContain('"headHash"');
  });

  it('exports only the requested tenant', async () => {
    const current = runtime();
    await current.sink.append(event);
    await current.sink.append({ ...event, id: 'event-2', organizationId: 'org-b' });
    await executeAuditCommand(['export', '--tenant', 'org-a', '--output', 'audit.ndjson'], current);
    expect(current.files.get('audit.ndjson')).toContain('event-1');
    expect(current.files.get('audit.ndjson')).not.toContain('event-2');
  });
});
