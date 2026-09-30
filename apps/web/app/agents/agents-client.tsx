'use client';

import { useState } from 'react';

interface Agent {
  id: string;
  slug: string;
  name: string;
  description?: string;
}
interface AgentVersion {
  id: string;
  version: number;
  status: string;
  model: string;
}
interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
  channels: string[];
  guardrails: string[];
}
type Tab =
  | 'General'
  | 'Prompt'
  | 'Model'
  | 'Tools'
  | 'MCP'
  | 'Knowledge'
  | 'Memory'
  | 'Guardrails'
  | 'Budget'
  | 'Permissions'
  | 'Publishing'
  | 'Versions';
const tabs: Tab[] = [
  'General',
  'Prompt',
  'Model',
  'Tools',
  'MCP',
  'Knowledge',
  'Memory',
  'Guardrails',
  'Budget',
  'Permissions',
  'Publishing',
  'Versions',
];
interface Draft {
  systemPrompt: string;
  model: string;
  tools: string;
  mcpServers: string;
  knowledgeBaseIds: string;
  memoryEnabled: boolean;
  guardrails: string;
  budgetUsd: string;
  permissions: string;
  publishChannels: string;
  maxIterations: string;
  timeoutMs: string;
}
const emptyDraft: Draft = {
  systemPrompt: '',
  model: '',
  tools: '',
  mcpServers: '',
  knowledgeBaseIds: '',
  memoryEnabled: false,
  guardrails: '',
  budgetUsd: '0',
  permissions: '',
  publishChannels: '',
  maxIterations: '10',
  timeoutMs: '120000',
};

async function request(path: string, token: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Request failed (${String(response.status)})`);
  return response.json() as Promise<Record<string, unknown>>;
}
function csv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function AgentsClient() {
  const [organizationId, setOrganizationId] = useState('');
  const [token, setToken] = useState('');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [selected, setSelected] = useState<Agent>();
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [tab, setTab] = useState<Tab>('General');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const base = `/api/v1/organizations/${encodeURIComponent(organizationId.trim())}`;
  const update = (field: keyof Draft, value: string | boolean) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };
  async function loadAgents() {
    try {
      const [result, templateResult] = await Promise.all([
        request(`${base}/agents`, token.trim()),
        request(`${base}/agents/templates`, token.trim()),
      ]);
      setAgents((result.items ?? []) as Agent[]);
      setTemplates((templateResult.items ?? []) as AgentTemplate[]);
      setConnected(true);
      setError('');
    } catch {
      setError(
        'Não foi possível carregar os agentes e templates. Verifique a organização e o token.',
      );
    }
  }
  async function loadVersions(agent: Agent) {
    try {
      const result = await request(`${base}/agents/${agent.id}/versions`, token.trim());
      setSelected(agent);
      setVersions((result.items ?? []) as AgentVersion[]);
      setTab('Versions');
      setError('');
    } catch {
      setError('Não foi possível carregar as versões do agente.');
    }
  }
  async function createAgent(form: FormData) {
    try {
      await request(`${base}/agents`, token.trim(), {
        method: 'POST',
        body: JSON.stringify({
          slug: form.get('slug'),
          name: form.get('name'),
          description: form.get('description'),
        }),
      });
      await loadAgents();
      setShowCreate(false);
    } catch {
      setError('Não foi possível criar o agente.');
    }
  }
  async function createVersion() {
    if (!selected) return;
    try {
      await request(`${base}/agents/${selected.id}/versions`, token.trim(), {
        method: 'POST',
        body: JSON.stringify({
          model: draft.model,
          systemPrompt: draft.systemPrompt,
          tools: csv(draft.tools),
          maxIterations: Number(draft.maxIterations),
          timeoutMs: Number(draft.timeoutMs),
          budgetUsd: Number(draft.budgetUsd),
          configuration: {
            mcpServers: csv(draft.mcpServers),
            knowledgeBaseIds: csv(draft.knowledgeBaseIds),
            memoryEnabled: draft.memoryEnabled,
            guardrails: csv(draft.guardrails),
            permissions: csv(draft.permissions),
            publishChannels: csv(draft.publishChannels),
          },
        }),
      });
      await loadVersions(selected);
      setDraft(emptyDraft);
    } catch {
      setError('Não foi possível criar a versão.');
    }
  }
  async function publish(version: AgentVersion) {
    if (!selected) return;
    try {
      await request(`${base}/agents/${selected.id}/versions/${version.id}/publish`, token.trim(), {
        method: 'POST',
      });
      await loadVersions(selected);
    } catch {
      setError('Não foi possível publicar a versão.');
    }
  }
  async function installTemplate(template: AgentTemplate) {
    try {
      await request(
        `${base}/agents/templates/${encodeURIComponent(template.id)}/install`,
        token.trim(),
        { method: 'POST' },
      );
      await loadAgents();
    } catch {
      setError(`Não foi possível instalar o template ${template.name}.`);
    }
  }
  if (!connected)
    return (
      <section className="panel narrow-panel">
        <h2>Conectar sessão administrativa</h2>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void loadAgents();
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
            Carregar agents
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  return (
    <div className="settings-stack">
      <section className="panel">
        <div className="settings-actions">
          <strong>{agents.length} agents</strong>
          <button
            className="primary-button"
            onClick={() => {
              setShowCreate(!showCreate);
            }}
          >
            Novo agent
          </button>
        </div>
        {showCreate && (
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void createAgent(new FormData(event.currentTarget));
            }}
          >
            <label>
              Slug
              <input name="slug" pattern="[a-z0-9][a-z0-9-]{1,62}" required />
            </label>
            <label>
              Nome
              <input name="name" required />
            </label>
            <label>
              Descrição
              <textarea name="description" />
            </label>
            <button className="primary-button" type="submit">
              Criar agent
            </button>
          </form>
        )}
        <ul>
          {agents.map((agent) => (
            <li key={agent.id}>
              <button
                className="link-button"
                onClick={() => {
                  void loadVersions(agent);
                }}
              >
                {agent.name} <span>({agent.slug})</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <div className="settings-actions">
          <div>
            <h2>Templates first-party</h2>
            <p>Instale um agente inicial versionado na organização.</p>
          </div>
          <strong>{templates.length} disponíveis</strong>
        </div>
        <ul>
          {templates.map((template) => (
            <li key={template.id}>
              <div>
                <strong>{template.name}</strong>
                <p>{template.description}</p>
                <small>
                  Modelo: {template.model} · Canais: {template.channels.join(', ')}
                </small>
              </div>
              <button
                className="secondary-button"
                onClick={() => {
                  void installTemplate(template);
                }}
              >
                Instalar
              </button>
            </li>
          ))}
        </ul>
      </section>
      {selected && (
        <section className="panel">
          <h2>{selected.name} · Agent Builder</h2>
          <div role="tablist" aria-label="Agent Builder tabs" className="settings-actions">
            {tabs.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                className={tab === item ? 'primary-button' : 'secondary-button'}
                onClick={() => {
                  setTab(item);
                }}
              >
                {item}
              </button>
            ))}
          </div>
          {tab === 'Versions' ? (
            <>
              <h3>Versions</h3>
              <ul>
                {versions.map((version) => (
                  <li key={version.id}>
                    v{version.version} · {version.model} · <strong>{version.status}</strong>
                    {version.status !== 'PUBLISHED' && (
                      <button
                        className="secondary-button"
                        onClick={() => {
                          void publish(version);
                        }}
                      >
                        Publicar
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="form-grid">
              <h3>{tab}</h3>
              {tab === 'General' && (
                <p>Configure a versioned agent for the {selected.slug} agent.</p>
              )}
              {tab === 'Prompt' && (
                <label>
                  System prompt
                  <textarea
                    value={draft.systemPrompt}
                    onChange={(event) => {
                      update('systemPrompt', event.target.value);
                    }}
                    required
                  />
                </label>
              )}
              {tab === 'Model' && (
                <>
                  <label>
                    Modelo
                    <input
                      value={draft.model}
                      onChange={(event) => {
                        update('model', event.target.value);
                      }}
                      required
                    />
                  </label>
                  <label>
                    Máximo de iterações
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={draft.maxIterations}
                      onChange={(event) => {
                        update('maxIterations', event.target.value);
                      }}
                    />
                  </label>
                  <label>
                    Timeout (ms)
                    <input
                      type="number"
                      min="1"
                      max="3600000"
                      value={draft.timeoutMs}
                      onChange={(event) => {
                        update('timeoutMs', event.target.value);
                      }}
                    />
                  </label>
                </>
              )}
              {tab === 'Tools' && (
                <label>
                  Tools (separadas por vírgula)
                  <input
                    value={draft.tools}
                    onChange={(event) => {
                      update('tools', event.target.value);
                    }}
                  />
                </label>
              )}
              {tab === 'MCP' && (
                <label>
                  MCP servers (separados por vírgula)
                  <input
                    value={draft.mcpServers}
                    onChange={(event) => {
                      update('mcpServers', event.target.value);
                    }}
                  />
                </label>
              )}
              {tab === 'Knowledge' && (
                <label>
                  Knowledge bases (separadas por vírgula)
                  <input
                    value={draft.knowledgeBaseIds}
                    onChange={(event) => {
                      update('knowledgeBaseIds', event.target.value);
                    }}
                  />
                </label>
              )}
              {tab === 'Memory' && (
                <label>
                  <input
                    type="checkbox"
                    checked={draft.memoryEnabled}
                    onChange={(event) => {
                      update('memoryEnabled', event.target.checked);
                    }}
                  />{' '}
                  Habilitar memória
                </label>
              )}
              {tab === 'Guardrails' && (
                <label>
                  Guardrails (separados por vírgula)
                  <input
                    value={draft.guardrails}
                    onChange={(event) => {
                      update('guardrails', event.target.value);
                    }}
                  />
                </label>
              )}
              {tab === 'Budget' && (
                <label>
                  Limite USD
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={draft.budgetUsd}
                    onChange={(event) => {
                      update('budgetUsd', event.target.value);
                    }}
                  />
                </label>
              )}
              {tab === 'Permissions' && (
                <label>
                  Permissions (separadas por vírgula)
                  <input
                    value={draft.permissions}
                    onChange={(event) => {
                      update('permissions', event.target.value);
                    }}
                  />
                </label>
              )}
              {tab === 'Publishing' && (
                <label>
                  Canais (WEB, REST_API, MCP, AGENT_TOOL)
                  <input
                    value={draft.publishChannels}
                    onChange={(event) => {
                      update('publishChannels', event.target.value);
                    }}
                  />
                </label>
              )}
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  void createVersion();
                }}
              >
                Criar versão
              </button>
            </div>
          )}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
