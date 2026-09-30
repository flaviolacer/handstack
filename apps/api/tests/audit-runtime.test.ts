import { InProcessEventBus } from '@handstack/core';
import { describe, expect, it } from 'vitest';
import { AuditRuntimeService } from '../src/audit/audit-runtime.service.js';

describe('audit runtime provenance', () => {
  it('persists trace correlation and publishes the complete execution context', async () => {
    const bus = new InProcessEventBus();
    const received: Record<string, unknown>[] = [];
    bus.subscribe('audit.recorded', (event) => {
      received.push(event as unknown as Record<string, unknown>);
      return Promise.resolve();
    });
    const runtime = new AuditRuntimeService(undefined, { bus } as never);

    await runtime.record({
      organizationId: 'org-audit',
      actorId: 'user-audit',
      action: 'JOB_DEAD_LETTER_RETRIED',
      resourceType: 'job',
      resourceId: 'job-1',
      context: {
        requestId: 'request-audit-1',
        traceId: 'trace-audit-1',
        principalId: 'user-audit',
        source: 'API',
      },
    });

    expect(await runtime.query('org-audit')).toMatchObject([
      {
        traceId: 'trace-audit-1',
        metadata: {
          __auditSequence: '0',
          __auditPreviousHash: 'GENESIS',
        },
      },
    ]);
    const event = (await runtime.query('org-audit'))[0];
    expect(event?.metadata?.__auditHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(runtime.verify('org-audit')).resolves.toMatchObject({ valid: true, checked: 1 });
    await expect(runtime.checkpoint('org-audit', 'runtime-signing-key')).resolves.toMatchObject({
      organizationId: 'org-audit',
      sequence: 0,
      eventId: event?.id,
    });
    expect(received[0]).toMatchObject({
      type: 'audit.recorded',
      context: {
        requestId: 'request-audit-1',
        traceId: 'trace-audit-1',
        principalId: 'user-audit',
        source: 'API',
      },
    });
  });
});
