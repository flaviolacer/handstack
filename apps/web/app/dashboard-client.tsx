'use client';

import { useState, type SyntheticEvent } from 'react';

interface Snapshot {
  usage: number;
  budgets: number;
  models: number;
  audit: number;
}

export function DashboardClient() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState('');

  async function load(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const organization = data.get('organizationId');
    const token = data.get('accessToken');
    if (
      typeof organization !== 'string' ||
      typeof token !== 'string' ||
      organization.trim() === '' ||
      token.trim() === ''
    )
      return;
    const headers = { authorization: `Bearer ${token.trim()}` };
    const base = `/api/v1/organizations/${encodeURIComponent(organization.trim())}`;
    const responses = await Promise.all(
      ['usage', 'budgets', 'models', 'audit'].map((endpoint) =>
        fetch(`${base}/${endpoint}`, { headers, cache: 'no-store' }),
      ),
    );
    if (responses.some((response) => !response.ok)) {
      setError('Unable to load the dashboard snapshot');
      return;
    }
    const values = await Promise.all(
      responses.map(async (response) => (await response.json()) as { items?: unknown[] }),
    );
    setSnapshot({
      usage: values[0]?.items?.length ?? 0,
      budgets: values[1]?.items?.length ?? 0,
      models: values[2]?.items?.length ?? 0,
      audit: values[3]?.items?.length ?? 0,
    });
    setError('');
  }

  return (
    <div className="settings-stack">
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
            Load dashboard
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
      {snapshot && (
        <section className="cards">
          <article className="card">
            <strong>{snapshot.usage}</strong>
            <p>Usage records</p>
          </article>
          <article className="card">
            <strong>{snapshot.budgets}</strong>
            <p>Budgets</p>
          </article>
          <article className="card">
            <strong>{snapshot.models}</strong>
            <p>Models</p>
          </article>
          <article className="card">
            <strong>{snapshot.audit}</strong>
            <p>Audit events</p>
          </article>
        </section>
      )}
    </div>
  );
}
