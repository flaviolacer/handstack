import { describe, expect, it } from 'vitest';
import { initializeTelemetry, PrometheusRegistry } from '../src/index.js';

describe('OpenTelemetry bootstrap', () => {
  it('does not initialize exporters when the privacy telemetry gate is disabled', async () => {
    const runtime = initializeTelemetry({
      enabled: true,
      privacyAllowed: false,
      serviceName: 'handstack-test',
      serviceVersion: '1.0.0',
    });
    expect(runtime.enabled).toBe(false);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it('is opt-in and shuts down safely while disabled', async () => {
    const runtime = initializeTelemetry({
      enabled: false,
      serviceName: 'handstack-test',
      serviceVersion: '0.0.0',
    });
    expect(runtime.enabled).toBe(false);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });
});

describe('Prometheus registry', () => {
  it('renders sorted samples and escapes label values', () => {
    const registry = new PrometheusRegistry();
    registry.set({
      name: 'handstack_requests_total',
      help: 'HTTP requests',
      type: 'counter',
      value: 3,
      labels: { organization: 'org"one', route: '/a\\b\n' },
    });
    expect(registry.render()).toBe(
      '# HELP handstack_requests_total HTTP requests\n' +
        '# TYPE handstack_requests_total counter\n' +
        'handstack_requests_total{organization="org\\"one",route="/a\\\\b\\n"} 3\n',
    );
  });

  it('rejects invalid names and non-finite values', () => {
    const registry = new PrometheusRegistry();
    expect(() => {
      registry.set({ name: 'bad-name', help: 'bad', type: 'gauge', value: 1 });
    }).toThrow('Invalid metric name');
    expect(() => {
      registry.set({ name: 'valid_metric', help: 'bad', type: 'gauge', value: Number.NaN });
    }).toThrow('finite');
  });
});
