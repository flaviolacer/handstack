import type { Span } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import {
  IdentityTelemetry,
  type IdentityObservation,
  type IdentityTelemetrySink,
} from '../src/index.js';

class RecordingSink implements IdentityTelemetrySink {
  readonly observations: IdentityObservation[] = [];
  readonly statuses: unknown[] = [];
  ended = 0;

  start(): Span {
    return {
      setStatus: (status) => {
        this.statuses.push(status);
        return this.span();
      },
      end: () => {
        this.ended += 1;
      },
    } as Span;
  }

  record(observation: IdentityObservation): void {
    this.observations.push(observation);
  }

  private span(): Span {
    return {} as Span;
  }
}

describe('identity telemetry', () => {
  it('records bounded success dimensions and duration', async () => {
    const sink = new RecordingSink();
    const clock = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(25);
    await expect(
      new IdentityTelemetry(sink, clock).measure('sso.callback', () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
    expect(sink.observations).toEqual([
      { operation: 'sso.callback', outcome: 'success', durationMs: 15 },
    ]);
    expect(sink.ended).toBe(1);
  });

  it('does not serialize exception messages or secrets on failure', async () => {
    const sink = new RecordingSink();
    const secret = new Error('token=secret claim=email@example.test');
    await expect(
      new IdentityTelemetry(sink, () => 1).measure('admin.provider.create', () =>
        Promise.reject(secret),
      ),
    ).rejects.toBe(secret);
    expect(JSON.stringify(sink.observations)).not.toContain('secret');
    expect(JSON.stringify(sink.statuses)).not.toContain('email@example.test');
    expect(sink.observations[0]).toMatchObject({ outcome: 'failure', durationMs: 0 });
  });
});
