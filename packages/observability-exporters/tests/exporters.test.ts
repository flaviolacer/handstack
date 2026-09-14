import { describe, expect, it } from 'vitest';
import {
  HttpObservabilityExporter,
  ObservabilityExportError,
  FanoutObservabilityExporter,
  type ExporterPayload,
} from '../src/index.js';

const event = {
  organizationId: 'org-1',
  signal: 'trace' as const,
  name: 'model.chat',
  timestamp: '2026-09-11T00:00:00.000Z',
  attributes: {
    model: 'internal-model',
    apiKey: 'hidden',
    nested: { password: 'hidden', ok: true },
  },
};

describe('observability exporters', () => {
  it('redacts sensitive attributes and batches official exporter payloads', async () => {
    const payloads: ExporterPayload[] = [];
    const exporter = new HttpObservabilityExporter(
      'otlp',
      {
        send: (payload) => {
          payloads.push(payload);
          return Promise.resolve();
        },
      },
      1,
    );
    await exporter.export([event, { ...event, name: 'model.stream' }]);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.events[0]?.attributes).toEqual({
      model: 'internal-model',
      apiKey: '[REDACTED]',
      nested: { password: '[REDACTED]', ok: true },
    });
  });

  it('supports all provider kinds through the transport boundary and fanout', async () => {
    const kinds: string[] = [];
    const exporters = (['otlp', 'langfuse', 'datadog', 'grafana', 'new_relic'] as const).map(
      (kind) =>
        new HttpObservabilityExporter(kind, {
          send: (payload) => {
            kinds.push(payload.kind);
            return Promise.resolve();
          },
        }),
    );
    await new FanoutObservabilityExporter(exporters).export([event]);
    expect(kinds.sort()).toEqual(['datadog', 'grafana', 'langfuse', 'new_relic', 'otlp']);
  });

  it('fails closed for invalid events and transport failures', async () => {
    await expect(
      new HttpObservabilityExporter('otlp', {
        send: () => Promise.reject(new Error('network')),
      }).export([event]),
    ).rejects.toThrowError(ObservabilityExportError);
    await expect(
      new HttpObservabilityExporter('otlp', { send: () => Promise.resolve() }).export([
        { ...event, organizationId: '' },
      ]),
    ).rejects.toThrowError(ObservabilityExportError);
  });
});
