import { metrics, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

export type IdentityOperation =
  | 'sso.start'
  | 'sso.callback'
  | 'admin.provider.list'
  | 'admin.provider.create'
  | 'admin.provider.enablement'
  | 'admin.provider.test_connection'
  | 'admin.policy.read'
  | 'admin.policy.update'
  | 'admin.break_glass.enable'
  | 'admin.break_glass.disable'
  | 'admin.user.deprovision'
  | 'admin.mapping.read'
  | 'admin.mapping.update';

export type IdentityOutcome = 'success' | 'failure';

export interface IdentityObservation {
  readonly operation: IdentityOperation;
  readonly outcome: IdentityOutcome;
  readonly durationMs: number;
}

export interface IdentityTelemetrySink {
  start(operation: IdentityOperation): Span | undefined;
  record(observation: IdentityObservation): void;
}

class OpenTelemetryIdentitySink implements IdentityTelemetrySink {
  private readonly tracer = trace.getTracer('@handstack/identity');
  private readonly meter = metrics.getMeter('@handstack/identity');
  private readonly operations = this.meter.createCounter('handstack_identity_operations_total');
  private readonly duration = this.meter.createHistogram(
    'handstack_identity_operation_duration_ms',
    { unit: 'ms' },
  );

  start(operation: IdentityOperation): Span {
    return this.tracer.startSpan(`handstack.identity.${operation}`, {
      attributes: { 'identity.operation': operation },
    });
  }

  record(observation: IdentityObservation): void {
    const attributes: Attributes = {
      'identity.operation': observation.operation,
      'identity.outcome': observation.outcome,
    };
    this.operations.add(1, attributes);
    this.duration.record(observation.durationMs, attributes);
  }
}

export class IdentityTelemetry {
  constructor(
    private readonly sink: IdentityTelemetrySink = new OpenTelemetryIdentitySink(),
    private readonly clock: () => number = () => performance.now(),
  ) {}

  async measure<T>(operation: IdentityOperation, work: () => Promise<T>): Promise<T> {
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

  private finish(operation: IdentityOperation, outcome: IdentityOutcome, startedAt: number): void {
    this.sink.record({ operation, outcome, durationMs: Math.max(0, this.clock() - startedAt) });
  }
}
