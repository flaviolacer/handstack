export type MetricType = 'counter' | 'gauge';

export interface MetricSample {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  readonly value: number;
  readonly labels?: Readonly<Record<string, string>>;
}

/** Small dependency-free Prometheus exposition registry for operational metrics. */
export class PrometheusRegistry {
  private readonly samples = new Map<string, MetricSample>();

  set(sample: MetricSample): void {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(sample.name))
      throw new Error(`Invalid metric name: ${sample.name}`);
    if (!Number.isFinite(sample.value))
      throw new Error(`Metric value must be finite: ${sample.name}`);
    this.samples.set(sampleKey(sample), { ...sample, value: sample.value });
  }

  increment(sample: Omit<MetricSample, 'value'>, amount = 1): void {
    if (!Number.isFinite(amount)) throw new Error('Metric increment must be finite');
    const key = sampleKey(sample);
    const current = this.samples.get(key);
    this.set({ ...sample, value: (current?.value ?? 0) + amount });
  }

  render(): string {
    const groups = new Map<string, MetricSample[]>();
    for (const sample of this.samples.values()) {
      const group = groups.get(sample.name) ?? [];
      group.push(sample);
      groups.set(sample.name, group);
    }
    const lines: string[] = [];
    for (const [name, samples] of [...groups.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const first = samples[0];
      if (first === undefined) continue;
      lines.push(`# HELP ${name} ${escapeHelp(first.help)}`, `# TYPE ${name} ${first.type}`);
      for (const sample of samples.sort((left, right) =>
        sampleKey(left).localeCompare(sampleKey(right)),
      )) {
        const labels = sample.labels === undefined ? '' : renderLabels(sample.labels);
        lines.push(`${name}${labels} ${String(sample.value)}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

function sampleKey(sample: Pick<MetricSample, 'name' | 'labels'>): string {
  const labels = Object.entries(sample.labels ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `${sample.name}{${labels.map(([name, value]) => `${name}=${value}`).join(',')}}`;
}

function renderLabels(labels: Readonly<Record<string, string>>): string {
  return `{${Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
    .join(',')}}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function escapeHelp(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}
