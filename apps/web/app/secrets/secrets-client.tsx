'use client';

import { useState, type SyntheticEvent } from 'react';

interface Secret {
  id: string;
  name: string;
  pluginId: string;
  createdAt: string;
  updatedAt: string;
}

export function SecretsClient() {
  const [organizationId, setOrganizationId] = useState('');
  const [token, setToken] = useState('');
  const [items, setItems] = useState<Secret[]>([]);
  const [message, setMessage] = useState('');
  const headers = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  async function load(event?: SyntheticEvent) {
    event?.preventDefault();
    const response = await fetch(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/secrets`,
      { headers: headers(), cache: 'no-store' },
    );
    if (!response.ok) {
      setMessage('Unable to load secrets');
      return;
    }
    setItems(((await response.json()) as { items?: Secret[] }).items ?? []);
    setMessage('');
  }
  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/secrets`,
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: data.get('name'),
          pluginId: data.get('pluginId'),
          value: data.get('value'),
        }),
      },
    );
    if (!response.ok) {
      setMessage('Unable to create secret');
      return;
    }
    event.currentTarget.reset();
    setMessage('Secret created');
    await load();
  }
  return (
    <div className="settings-stack">
      <section className="panel narrow-panel">
        <h2>Connect an administrative session</h2>
        <form
          className="form-grid"
          onSubmit={(event) => {
            void load(event);
          }}
        >
          <label>
            Organization ID
            <input
              value={organizationId}
              onChange={(event) => {
                setOrganizationId(event.target.value);
              }}
              required
            />
          </label>
          <label>
            Bearer access token
            <input
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
              }}
              type="password"
              required
            />
          </label>
          <button className="primary-button" type="submit">
            Load secrets
          </button>
        </form>
      </section>
      <section className="panel">
        <h2>Add secret</h2>
        <form
          className="form-grid"
          onSubmit={(event) => {
            void create(event);
          }}
        >
          <label>
            Name
            <input name="name" required />
          </label>
          <label>
            Plugin/context ID
            <input name="pluginId" required />
          </label>
          <label>
            Value
            <input name="value" type="password" required />
          </label>
          <button className="primary-button" type="submit">
            Store encrypted secret
          </button>
        </form>
        {message && <p role="status">{message}</p>}
      </section>
      <section className="panel">
        <h2>Configured references</h2>
        {items.length === 0 ? (
          <p className="muted">No secrets loaded.</p>
        ) : (
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <code>secret://{item.id}</code> · {item.name} · {item.pluginId}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
