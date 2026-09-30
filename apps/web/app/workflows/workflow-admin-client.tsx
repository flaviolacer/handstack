'use client';

import { useState } from 'react';

interface Workflow {
  id: string;
  name: string;
  status?: string;
  trigger?: string;
}

export function WorkflowAdminClient() {
  const [organizationId, setOrganizationId] = useState('');
  const [token, setToken] = useState('');
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [connected, setConnected] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');
  async function call(path: string, init?: RequestInit) {
    const response = await fetch(
      `/api/v1/organizations/${encodeURIComponent(organizationId.trim())}/workflows${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${token.trim()}`,
          ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        cache: 'no-store',
      },
    );
    if (!response.ok) throw new Error(`Request failed (${String(response.status)})`);
    return response.json() as Promise<{ items?: Workflow[] }>;
  }
  async function load() {
    try {
      const result = await call('');
      setWorkflows(result.items ?? []);
      setConnected(true);
      setError('');
    } catch {
      setError('Não foi possível carregar os workflows.');
    }
  }
  async function create(form: FormData) {
    try {
      const raw = form.get('payload');
      if (typeof raw !== 'string') throw new Error('payload');
      const payload: unknown = JSON.parse(raw) as unknown;
      await call('', { method: 'POST', body: JSON.stringify(payload) });
      await load();
      setShowCreate(false);
    } catch {
      setError('Payload inválido ou criação do workflow recusada.');
    }
  }
  async function publish(workflow: Workflow) {
    try {
      await call(`/${encodeURIComponent(workflow.id)}/publish`, { method: 'POST' });
      await load();
    } catch {
      setError('Não foi possível publicar o workflow.');
    }
  }
  if (!connected)
    return (
      <section className="panel narrow-panel">
        <h2>Conectar administração de workflows</h2>
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
            Carregar workflows
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  return (
    <div className="settings-stack">
      <section className="panel">
        <div className="settings-actions">
          <strong>{workflows.length} workflows</strong>
          <button
            className="primary-button"
            onClick={() => {
              setShowCreate(!showCreate);
            }}
          >
            Novo workflow
          </button>
        </div>
        {showCreate && (
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void create(new FormData(event.currentTarget));
            }}
          >
            <label>
              JSON do workflow
              <textarea
                name="payload"
                defaultValue={
                  '{"name":"Example workflow","trigger":"manual","nodes":[{"id":"start","kind":"Agent","config":{}}],"edges":[]}'
                }
                required
              />
            </label>
            <button className="primary-button" type="submit">
              Criar draft
            </button>
          </form>
        )}
        <ul>
          {workflows.map((workflow) => (
            <li key={workflow.id}>
              <strong>{workflow.name}</strong> · {workflow.trigger ?? 'manual'} ·{' '}
              {workflow.status ?? 'DRAFT'}{' '}
              {workflow.status !== 'PUBLISHED' && (
                <button
                  className="secondary-button"
                  onClick={() => {
                    void publish(workflow);
                  }}
                >
                  Publicar
                </button>
              )}
            </li>
          ))}
        </ul>
        {error && <p role="alert">{error}</p>}
      </section>
    </div>
  );
}
