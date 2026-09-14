import type { Span } from '@opentelemetry/api';
import {
  AiGovernanceOpenTelemetry,
  type AiGovernanceObservation,
  type AiGovernanceTelemetrySink,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

class RecordingSink implements AiGovernanceTelemetrySink {
  readonly started: string[] = [];
  readonly observations: AiGovernanceObservation[] = [];
  readonly statuses: unknown[] = [];
  ended = 0;

  start(operation: AiGovernanceObservation['operation']): Span {
    this.started.push(operation);
    return {
      setStatus: (status: unknown) => {
        this.statuses.push(status);
        return this;
      },
      end: () => {
        this.ended += 1;
      },
    } as unknown as Span;
  }

  record(observation: AiGovernanceObservation): void {
    this.observations.push(observation);
  }
}

describe('AI governance telemetry', () => {
  it('records closed success/failure observations without payloads or error messages', async () => {
    const sink = new RecordingSink();
    const ticks = [10, 15, 20, 29];
    const telemetry = new AiGovernanceOpenTelemetry(sink, () => ticks.shift() ?? 29);

    await expect(telemetry.measure('model.publish', () => Promise.resolve('ok'))).resolves.toBe(
      'ok',
    );
    await expect(
      telemetry.measure('evaluation.run', () => Promise.reject(new Error('sensitive prompt'))),
    ).rejects.toThrow('sensitive prompt');

    expect(sink.observations).toEqual([
      { operation: 'model.publish', outcome: 'success', durationMs: 5 },
      { operation: 'evaluation.run', outcome: 'failure', durationMs: 9 },
    ]);
    expect(JSON.stringify(sink)).not.toContain('sensitive prompt');
    expect(sink.ended).toBe(2);
  });

  it('keeps streaming semantics while measuring completion and iteration failure', async () => {
    const sink = new RecordingSink();
    let tick = 0;
    const telemetry = new AiGovernanceOpenTelemetry(sink, () => tick++);
    const values: number[] = [];
    for await (const value of telemetry.measureStream('model.stream', async function* () {
      await Promise.resolve();
      yield 1;
      yield 2;
    }))
      values.push(value);
    await expect(async () => {
      for await (const value of telemetry.measureStream('model.stream', async function* () {
        yield await Promise.reject<number>(new Error('private provider response'));
      })) {
        values.push(value);
      }
    }).rejects.toThrow('private provider response');
    expect(values).toEqual([1, 2]);
    expect(sink.observations.map(({ outcome }) => outcome)).toEqual(['success', 'failure']);
    expect(JSON.stringify(sink)).not.toContain('private provider response');
  });
});
