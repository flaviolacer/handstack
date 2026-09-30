'use client';

import { useState, type SyntheticEvent } from 'react';

interface AdminResourceClientProps {
  readonly title: string;
  readonly endpoint: 'users' | 'groups' | 'roles';
  readonly fields: readonly { readonly name: string; readonly label: string }[];
  readonly helpHref: string;
}

function value(data: FormData, name: string): string {
  const result = data.get(name);
  return typeof result === 'string' ? result.trim() : '';
}

function itemsFromResponse(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (typeof value === 'object' && value !== null && 'items' in value) {
    const items = (value as { items?: unknown }).items;
    return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
  }
  return [];
}

export function AdminResourceClient({
  title,
  endpoint,
  fields,
  helpHref,
}: AdminResourceClientProps) {
  const [session, setSession] = useState<{ organizationId: string; accessToken: string }>();
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Record<string, unknown> | undefined>();
  const baseUrl = process.env.NEXT_PUBLIC_HANDSTACK_API_URL ?? '';

  async function request(path: string, init?: RequestInit) {
    if (session === undefined) return;
    const response = await fetch(
      `${baseUrl}/api/v1/organizations/${encodeURIComponent(session.organizationId)}/${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        cache: 'no-store',
      },
    );
    if (!response.ok) throw new Error(`Unable to load ${title.toLowerCase()}`);
    return itemsFromResponse(await response.json());
  }

  async function load(active: { organizationId: string; accessToken: string }) {
    setSession(active);
    try {
      const response = await fetch(
        `${baseUrl}/api/v1/organizations/${encodeURIComponent(active.organizationId)}/${endpoint}`,
        {
          headers: { authorization: `Bearer ${active.accessToken}` },
          cache: 'no-store',
        },
      );
      if (!response.ok) throw new Error(`Unable to load ${title.toLowerCase()}`);
      setItems(itemsFromResponse(await response.json()));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed');
    }
  }

  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === undefined) return;
    const data = new FormData(event.currentTarget);
    try {
      await request(endpoint, {
        method: 'POST',
        body: JSON.stringify(
          Object.fromEntries(fields.map((field) => [field.name, value(data, field.name)])),
        ),
      });
      const refreshed = await request(endpoint);
      setItems(refreshed ?? []);
      setShowForm(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Create request failed');
    }
  }

  async function update(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === undefined || typeof editing?.id !== 'string') return;
    const data = new FormData(event.currentTarget);
    try {
      await request(`${endpoint}/${encodeURIComponent(editing.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(
          Object.fromEntries(
            fields
              .filter((field) => field.name !== 'username')
              .map((field) => [field.name, value(data, field.name)]),
          ),
        ),
      });
      const refreshed = await request(endpoint);
      setItems(refreshed ?? []);
      setEditing(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Update request failed');
    }
  }

  if (session === undefined) {
    return (
      <section className="panel narrow-panel">
        <h2>Connect an administrative session</h2>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void load({
              organizationId: value(data, 'organizationId'),
              accessToken: value(data, 'accessToken'),
            });
          }}
        >
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
  }

  return (
    <div className="settings-stack">
      <div className="settings-actions">
        <strong>
          {items.length} {title.toLowerCase()}
        </strong>
        <span className="settings-actions">
          <a className="context-help" href={helpHref} aria-label={`Help for ${title}`}>
            ?
          </a>
          <button
            className="primary-button"
            onClick={() => {
              setShowForm(!showForm);
            }}
          >
            Add
          </button>
        </span>
      </div>
      {showForm && (
        <form
          className="panel form-grid"
          onSubmit={(event) => {
            void create(event);
          }}
        >
          {fields.map((field) => (
            <label key={field.name}>
              {field.label}
              <input name={field.name} required />
            </label>
          ))}
          <button className="primary-button" type="submit">
            Create
          </button>
        </form>
      )}
      {editing && (
        <form
          key={String(editing.id)}
          className="panel form-grid"
          onSubmit={(event) => {
            void update(event);
          }}
        >
          <h2>Edit {title.slice(0, -1)}</h2>
          {fields
            .filter((field) => field.name !== 'username')
            .map((field) => (
              <label key={field.name}>
                {field.label}
                <input
                  name={field.name}
                  defaultValue={
                    typeof editing[field.name] === 'string' ? (editing[field.name] as string) : ''
                  }
                  required
                />
              </label>
            ))}
          <div className="settings-actions">
            <button className="primary-button" type="submit">
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(undefined);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="error-panel" role="alert">
          {error}
        </p>
      )}
      <section className="panel">
        <ul>
          {items.map((item, index) => {
            const fallback = `item-${String(index)}`;
            const label = item.displayName ?? item.name ?? item.username ?? item.id ?? fallback;
            const key = typeof item.id === 'string' ? item.id : fallback;
            return (
              <li key={key} className="settings-actions">
                <span>{typeof label === 'string' ? label : key}</span>
                {typeof item.id === 'string' && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(item);
                      setShowForm(false);
                    }}
                  >
                    Edit
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
