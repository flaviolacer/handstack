import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  readonly enabled: boolean;
  /** Consent/privacy gate; export is disabled when explicitly false. */
  readonly privacyAllowed?: boolean;
  readonly serviceName: string;
  readonly serviceVersion: string;
  /** Base OTLP/HTTP endpoint, for example http://otel-collector:4318. */
  readonly otlpEndpoint?: string;
  readonly metricExportIntervalMillis?: number;
}
export interface TelemetryRuntime {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

export function initializeTelemetry(options: TelemetryOptions): TelemetryRuntime {
  if (!options.enabled || options.privacyAllowed === false)
    return { enabled: false, shutdown: () => Promise.resolve() };
  const endpoint = options.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const exporters: {
    readonly traceExporter?: OTLPTraceExporter;
    readonly metricExporter?: OTLPMetricExporter;
  } = endpoint === undefined ? {} : otlpExporters(endpoint);
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } }),
    ],
    ...(exporters.traceExporter === undefined ? {} : { traceExporter: exporters.traceExporter }),
    ...(exporters.metricExporter === undefined
      ? {}
      : {
          metricReader: new PeriodicExportingMetricReader({
            exporter: exporters.metricExporter,
            exportIntervalMillis: options.metricExportIntervalMillis ?? 60_000,
          }),
        }),
  });
  sdk.start();
  return { enabled: true, shutdown: async () => sdk.shutdown() };
}

function otlpExporters(endpoint: string): {
  readonly traceExporter: OTLPTraceExporter;
  readonly metricExporter: OTLPMetricExporter;
} {
  const base = endpoint.replace(/\/$/, '');
  return {
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricExporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
  };
}
