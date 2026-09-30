'use client';

import { useState, type SyntheticEvent } from 'react';

interface UsageRecord {
  readonly principalId?: unknown;
  readonly scopeType?: unknown;
  readonly scopeKey?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly costUsd?: unknown;
  readonly latencyMs?: unknown;
  readonly outcome?: unknown;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function text(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : 'unknown';
}

function aggregate(
  items: readonly UsageRecord[],
  key: (item: UsageRecord) => string,
): readonly [string, number][] {
  const values = new Map<string, number>();
  for (const item of items)
    values.set(key(item), (values.get(key(item)) ?? 0) + number(item.costUsd));
  return [...values.entries()].sort((left, right) => right[1] - left[1]);
}

export function UsageDashboardClient() {
  const [items, setItems] = useState<UsageRecord[]>();
  const [error, setError] = useState('');

  async function load(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const organizationId = data.get('organizationId');
    const accessToken = data.get('accessToken');
    if (
      typeof organizationId !== 'string' ||
      typeof accessToken !== 'string' ||
      organizationId.trim() === '' ||
      accessToken.trim() === ''
    )
      return;
    const response = await fetch(
      `/api/v1/organizations/${encodeURIComponent(organizationId.trim())}/usage`,
      { headers: { authorization: `Bearer ${accessToken.trim()}` }, cache: 'no-store' },
    );
    if (!response.ok) {
      setError('Unable to load usage');
      return;
    }
    const body = (await response.json()) as { items?: unknown };
    setItems(Array.isArray(body.items) ? (body.items as UsageRecord[]) : []);
    setError('');
  }

  if (items === undefined)
    return (
      <section className="panel narrow-panel">
        <h2>Connect an administrative session</h2>
        <form className="form-grid" onSubmit={(event) => void load(event)}>
          <label>
            Organization ID
            <input name="organizationId" required />
          </label>
          <label>
            Bearer access token
            <input name="accessToken" type="password" required />
          </label>
          <button className="primary-button" type="submit">
            Load usage dashboard
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    );

  const total = items.reduce((sum, item) => sum + number(item.costUsd), 0);
  const tokens = items.reduce(
    (sum, item) => sum + number(item.inputTokens) + number(item.outputTokens),
    0,
  );
  const latencies = items.map((item) => number(item.latencyMs)).filter((value) => value > 0);
  const averageLatency =
    latencies.length === 0
      ? undefined
      : latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
  const errors = items.filter((item) => item.outcome === 'ERROR').length;
  const groups = (type: string) =>
    aggregate(
      items.filter((item) => item.scopeType === type),
      (item) => text(item.scopeKey),
    );
  const panels: readonly [string, readonly [string, number][]][] = [
    ['Spend per provider', aggregate(items, (item) => text(item.provider))],
    ['Spend per model', aggregate(items, (item) => text(item.model))],
    ['Spend per user', aggregate(items, (item) => text(item.principalId))],
    ['Spend per agent', groups('AGENT')],
    ['Spend per group', groups('GROUP')],
  ];
  return (
    <div className="settings-stack">
      <section className="cards">
        <article className="card">
          <strong>${total.toFixed(4)}</strong>
          <p>Total spend</p>
        </article>
        <article className="card">
          <strong>{tokens.toLocaleString()}</strong>
          <p>Token consumption</p>
        </article>
        <article className="card">
          <strong>{items.length}</strong>
          <p>Requests</p>
        </article>
        <article className="card">
          <strong>{errors}</strong>
          <p>Errors</p>
        </article>
        <article className="card">
          <strong>{averageLatency === undefined ? '—' : `${averageLatency.toFixed(0)} ms`}</strong>
          <p>Average latency</p>
        </article>
      </section>
      <div className="cards">
        {panels.map(([title, values]) => (
          <section className="panel" key={title}>
            <h2>{title}</h2>
            {values.length === 0 ? (
              <p className="muted">No recorded data.</p>
            ) : (
              <ul>
                {values.map(([label, value]) => (
                  <li key={label} className="settings-actions">
                    <span>{label}</span>
                    <strong>${value.toFixed(4)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
