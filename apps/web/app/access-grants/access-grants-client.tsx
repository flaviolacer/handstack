'use client';

import { useState } from 'react';

interface Grant {
  id: string;
  requestId: string;
  subjectId: string;
  resource: string;
  expiresAt?: string;
  revokedAt?: string;
}

export function AccessGrantsClient() {
  const [organizationId, setOrganizationId] = useState('');
  const [token, setToken] = useState('');
  const [grants, setGrants] = useState<Grant[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    try {
      const response = await fetch(
        `/api/v1/organizations/${encodeURIComponent(organizationId.trim())}/access-requests/grants`,
        { headers: { authorization: `Bearer ${token.trim()}` }, cache: 'no-store' },
      );
      if (!response.ok) throw new Error('load');
      const result = (await response.json()) as { items?: Grant[] };
      setGrants(result.items ?? []);
      setConnected(true);
      setError('');
    } catch {
      setError('Não foi possível carregar os grants.');
    }
  }
  async function revoke(grant: Grant) {
    if (grant.revokedAt !== undefined || !window.confirm(`Revogar acesso a ${grant.resource}?`))
      return;
    try {
      const response = await fetch(
        `/api/v1/organizations/${encodeURIComponent(organizationId.trim())}/access-requests/${encodeURIComponent(grant.requestId)}/grants/${encodeURIComponent(grant.id)}/revoke`,
        { method: 'POST', headers: { authorization: `Bearer ${token.trim()}` } },
      );
      if (!response.ok) throw new Error('revoke');
      await load();
    } catch {
      setError('Não foi possível revogar o grant.');
    }
  }
  if (!connected)
    return (
      <section className="panel narrow-panel">
        <h2>Conectar administração de grants</h2>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
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
            Carregar grants
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  return (
    <section className="panel">
      <h2>{grants.length} grants</h2>
      <ul>
        {grants.map((grant) => (
          <li key={grant.id}>
            <strong>{grant.resource}</strong> · {grant.subjectId} ·{' '}
            {grant.revokedAt === undefined ? 'ACTIVE' : 'REVOKED'}{' '}
            {grant.revokedAt === undefined && (
              <button
                className="secondary-button"
                onClick={() => {
                  void revoke(grant);
                }}
              >
                Revogar
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
