'use client';

import { useState } from 'react';

interface InstalledPlugin {
  record: {
    manifest: { name: string; version: string };
    status: 'INSTALLED' | 'ENABLED' | 'DISABLED';
  };
}

export function PluginAdminClient() {
  const [organizationId, setOrganizationId] = useState('');
  const [token, setToken] = useState('');
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  async function call(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(
      `/api/v1/organizations/${encodeURIComponent(organizationId.trim())}/plugins${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token.trim()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-store',
      },
    );
    if (!response.ok) throw new Error(`Request failed (${String(response.status)})`);
    return response.json() as Promise<{ items?: InstalledPlugin[] }>;
  }
  async function load() {
    try {
      const result = await call('');
      setPlugins(result.items ?? []);
      setConnected(true);
      setError('');
    } catch {
      setError('Não foi possível carregar os plugins instalados.');
    }
  }
  async function change(name: string, action: 'enable' | 'disable' | 'uninstall') {
    try {
      await call(
        `/${encodeURIComponent(name)}${action === 'uninstall' ? '' : `/${action}`}`,
        action === 'uninstall' ? 'DELETE' : 'PATCH',
      );
      await load();
    } catch {
      setError(`Não foi possível executar ${action} no plugin.`);
    }
  }
  async function quarantine(plugin: InstalledPlugin) {
    const reason = reasons[plugin.record.manifest.name]?.trim() ?? '';
    if (reason === '') {
      setError('Informe o motivo da quarentena antes de continuar.');
      return;
    }
    try {
      await call(`/${encodeURIComponent(plugin.record.manifest.name)}/quarantine`, 'PATCH', {
        version: plugin.record.manifest.version,
        reason,
      });
      await load();
    } catch {
      setError('Não foi possível colocar o plugin em quarentena.');
    }
  }
  if (!connected)
    return (
      <section className="panel narrow-panel">
        <h2>Conectar administração de plugins</h2>
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
            Load installed plugins
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  return (
    <section className="panel">
      <h2>Lifecycle administrativo</h2>
      {plugins.length === 0 && <p className="muted">Nenhum plugin instalado.</p>}
      <ul>
        {plugins.map((plugin) => {
          const name = plugin.record.manifest.name;
          return (
            <li key={name}>
              <strong>{name}</strong> v{plugin.record.manifest.version} · {plugin.record.status}{' '}
              {plugin.record.status !== 'ENABLED' && (
                <button
                  className="secondary-button"
                  onClick={() => {
                    void change(name, 'enable');
                  }}
                >
                  Enable
                </button>
              )}
              {plugin.record.status === 'ENABLED' && (
                <button
                  className="secondary-button"
                  onClick={() => {
                    void change(name, 'disable');
                  }}
                >
                  Disable
                </button>
              )}
              <input
                aria-label={`Motivo da quarentena de ${name}`}
                placeholder="Motivo da quarentena"
                value={reasons[name] ?? ''}
                onChange={(event) => {
                  setReasons((current) => ({ ...current, [name]: event.target.value }));
                }}
              />
              <button
                className="secondary-button"
                onClick={() => {
                  void quarantine(plugin);
                }}
              >
                Quarantine
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  void change(name, 'uninstall');
                }}
              >
                Uninstall
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
