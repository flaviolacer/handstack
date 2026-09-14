import { metrics, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import type { AiGovernanceOperation, AiGovernanceTelemetry } from '@handstack/models';

export type AiGovernanceOutcome = 'success' | 'failure';

export interface AiGovernanceObservation {
  readonly operation: AiGovernanceOperation;
  readonly outcome: AiGovernanceOutcome;
  readonly durationMs: number;
}

export interface AiGovernanceTelemetrySink {
  start(operation: AiGovernanceOperation): Span | undefined;
  record(observation: AiGovernanceObservation): void;
}

class OpenTelemetryAiGovernanceSink implements AiGovernanceTelemetrySink {
  private readonly tracer = trace.getTracer('@handstack/ai-governance');
  private readonly meter = metrics.getMeter('@handstack/ai-governance');
  private readonly operations = this.meter.createCounter(
    'handstack_ai_governance_operations_total',
  );
  private readonly duration = this.meter.createHistogram(
    'handstack_ai_governance_operation_duration_ms',
    { unit: 'ms' },
  );

  start(operation: AiGovernanceOperation): Span {
    return this.tracer.startSpan(`handstack.ai_governance.${operation}`, {
      attributes: { 'ai.operation': operation },
    });
  }

  record(observation: AiGovernanceObservation): void {
    const attributes: Attributes = {
      'ai.operation': observation.operation,
      'ai.outcome': observation.outcome,
    };
    this.operations.add(1, attributes);
    this.duration.record(observation.durationMs, attributes);
  }
}

export class AiGovernanceOpenTelemetry implements AiGovernanceTelemetry {
  constructor(
    private readonly sink: AiGovernanceTelemetrySink = new OpenTelemetryAiGovernanceSink(),
    private readonly clock: () => number = () => performance.now(),
  ) {}

  async measure<T>(operation: AiGovernanceOperation, work: () => Promise<T>): Promise<T> {
    const startedAt = this.clock();
    const span = this.sink.start(operation);
    try {
      const result = await work();
      span?.setStatus({ code: SpanStatusCode.OK });
      this.finish(operation, 'success', startedAt);
      return result;
    } catch (error) {
      span?.setStatus({ code: SpanStatusCode.ERROR });
      this.finish(operation, 'failure', startedAt);
      throw error;
    } finally {
      span?.end();
    }
  }

  async *measureStream<T>(
    operation: AiGovernanceOperation,
    work: () => AsyncIterable<T>,
  ): AsyncIterable<T> {
    const startedAt = this.clock();
    const span = this.sink.start(operation);
    try {
      for await (const item of work()) yield item;
      span?.setStatus({ code: SpanStatusCode.OK });
      this.finish(operation, 'success', startedAt);
    } catch (error) {
      span?.setStatus({ code: SpanStatusCode.ERROR });
      this.finish(operation, 'failure', startedAt);
      throw error;
    } finally {
      span?.end();
    }
  }

  private finish(
    operation: AiGovernanceOperation,
    outcome: AiGovernanceOutcome,
    startedAt: number,
  ): void {
    this.sink.record({ operation, outcome, durationMs: Math.max(0, this.clock() - startedAt) });
  }
}
