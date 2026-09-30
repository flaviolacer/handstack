'use client';

import { useState, type SyntheticEvent } from 'react';

export function CatalogClient({
  title,
  endpoint,
  createExample,
}: {
  readonly title: string;
  readonly endpoint: string;
  readonly createExample?: string;
}) {
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  async function load(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const organizationId = data.get('organizationId');
    const token = data.get('accessToken');
    const organization = typeof organizationId === 'string' ? organizationId.trim() : '';
    const accessToken = typeof token === 'string' ? token.trim() : '';
    const response = await fetch(
      `/api/v1/organizations/${encodeURIComponent(organization)}/${endpoint}`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      },
    );
    if (!response.ok) {
      setError(`Unable to load ${title.toLowerCase()}`);
      return;
    }
    const result = (await response.json()) as { items?: Record<string, unknown>[] };
    setItems(result.items ?? []);
    setLoaded(true);
    setError('');
  }
  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const org = data.get('organizationId');
    const token = data.get('accessToken');
    const payload = data.get('payload');
    if (typeof org !== 'string' || typeof token !== 'string' || typeof payload !== 'string') return;
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      setError('Payload must be valid JSON');
      return;
    }
    const response = await fetch(
      `/api/v1/organizations/${encodeURIComponent(org.trim())}/${endpoint}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token.trim()}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      setError(`Unable to create ${title.toLowerCase()}`);
      return;
    }
    setShowCreate(false);
    setError('');
    const refreshed = await fetch(
      `/api/v1/organizations/${encodeURIComponent(org.trim())}/${endpoint}`,
      {
        headers: { authorization: `Bearer ${token.trim()}` },
        cache: 'no-store',
      },
    );
    if (refreshed.ok) {
      const result = (await refreshed.json()) as { items?: Record<string, unknown>[] };
      setItems(result.items ?? []);
    }
  }
  if (!loaded)
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
            Load {title.toLowerCase()}
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  return (
    <div className="settings-stack">
      <section className="panel">
        <div className="settings-actions">
          <strong>
            {items.length} {title.toLowerCase()}
          </strong>
          {createExample && (
            <button
              className="primary-button"
              onClick={() => {
                setShowCreate(!showCreate);
              }}
            >
              Create
            </button>
          )}
        </div>
        {showCreate && (
          <form className="form-grid" onSubmit={(event) => void create(event)}>
            <label>
              Organization ID
              <input name="organizationId" required />
            </label>
            <label>
              Bearer access token
              <input name="accessToken" type="password" required />
            </label>
            <label>
              JSON payload
              <textarea name="payload" defaultValue={createExample} required />
            </label>
            <button className="primary-button" type="submit">
              Create
            </button>
          </form>
        )}
        <ul>
          {items.map((item, index) => {
            const key = typeof item.id === 'string' ? item.id : `item-${String(index)}`;
            const label = item.displayName ?? item.name ?? item.slug ?? item.id ?? key;
            return <li key={key}>{typeof label === 'string' ? label : key}</li>;
          })}
        </ul>
      </section>
    </div>
  );
}
