'use client';

import { useState, type SyntheticEvent } from 'react';

export function OperationsClient({
  title,
  endpoint,
}: {
  readonly title: string;
  readonly endpoint: string;
}) {
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState('');
  async function load(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const org = data.get('organizationId');
    const token = data.get('accessToken');
    const organizationId = typeof org === 'string' ? org.trim() : '';
    const accessToken = typeof token === 'string' ? token.trim() : '';
    const response = await fetch(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/${endpoint}`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      },
    );
    if (!response.ok) {
      setError(`Unable to load ${title.toLowerCase()}`);
      return;
    }
    setResult(await response.json());
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
            Load {title.toLowerCase()}
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
      {result !== undefined && (
        <section className="panel">
          <h2>{title}</h2>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
