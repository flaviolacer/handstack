export type ObservabilityExporterKind = 'otlp' | 'langfuse' | 'datadog' | 'grafana' | 'new_relic';
export type ObservabilitySignal = 'trace' | 'metric' | 'log';

export interface ObservabilityEvent {
  readonly organizationId: string;
  readonly signal: ObservabilitySignal;
  readonly name: string;
  readonly timestamp: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly value?: number;
}

export interface ExporterPayload {
  readonly kind: ObservabilityExporterKind;
  readonly events: readonly ObservabilityEvent[];
}

export interface ObservabilityTransport {
  send(payload: ExporterPayload): Promise<void>;
}

export interface ObservabilityExporter {
  readonly kind: ObservabilityExporterKind;
  export(events: readonly ObservabilityEvent[]): Promise<void>;
}

export class ObservabilityExportError extends Error {
  constructor(
    readonly kind: ObservabilityExporterKind,
    readonly code: 'INVALID_EVENT' | 'TRANSPORT',
  ) {
    super(`Observability export failed: ${code}`);
    this.name = 'ObservabilityExportError';
  }
}

const sensitiveKey =
  /(authorization|password|secret|token|api.?key|credential|prompt|response|claim|exception|stack)/i;

export function redactObservabilityEvent(event: ObservabilityEvent): ObservabilityEvent {
  if (event.organizationId === '' || event.name === '' || event.timestamp === '')
    throw new ObservabilityExportError('otlp', 'INVALID_EVENT');
  if (event.value !== undefined && !Number.isFinite(event.value))
    throw new ObservabilityExportError('otlp', 'INVALID_EVENT');
  return {
    organizationId: event.organizationId,
    signal: event.signal,
    name: event.name,
    timestamp: event.timestamp,
    ...(event.value === undefined ? {} : { value: event.value }),
    ...(event.attributes === undefined ? {} : { attributes: redactRecord(event.attributes) }),
  };
}

export class HttpObservabilityExporter implements ObservabilityExporter {
  readonly kind: ObservabilityExporterKind;

  constructor(
    kind: ObservabilityExporterKind,
    private readonly transport: ObservabilityTransport,
    private readonly maxBatchSize = 100,
  ) {
    if (!Number.isInteger(maxBatchSize) || maxBatchSize <= 0)
      throw new Error('maxBatchSize must be positive');
    this.kind = kind;
  }

  async export(events: readonly ObservabilityEvent[]): Promise<void> {
    const sanitized = events.map(redactObservabilityEvent);
    for (let offset = 0; offset < sanitized.length; offset += this.maxBatchSize) {
      try {
        await this.transport.send({
          kind: this.kind,
          events: sanitized.slice(offset, offset + this.maxBatchSize),
        });
      } catch {
        throw new ObservabilityExportError(this.kind, 'TRANSPORT');
      }
    }
  }
}

export class FanoutObservabilityExporter implements ObservabilityExporter {
  readonly kind = 'otlp' as const;

  constructor(private readonly exporters: readonly ObservabilityExporter[]) {}

  async export(events: readonly ObservabilityEvent[]): Promise<void> {
    await Promise.all(this.exporters.map((exporter) => exporter.export(events)));
  }
}

function redactRecord(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      sensitiveKey.test(key) ? '[REDACTED]' : redactValue(value),
    ]),
  );
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object')
    return redactRecord(value as Readonly<Record<string, unknown>>);
  return value;
}
