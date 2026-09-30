'use client';

import { useState, type SyntheticEvent } from 'react';

interface Session {
  readonly organizationId: string;
  readonly accessToken: string;
}

function field(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function display(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function DirectoryAssignmentsClient() {
  const [session, setSession] = useState<Session>();
  const [memberships, setMemberships] = useState<Record<string, unknown>[]>([]);
  const [roles, setRoles] = useState<Record<string, unknown>[]>([]);
  const [principalRoles, setPrincipalRoles] = useState<Record<string, unknown>[]>([]);
  const [permissions, setPermissions] = useState<Record<string, unknown>[]>([]);
  const [rolePermissions, setRolePermissions] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState('');
  const baseUrl = process.env.NEXT_PUBLIC_HANDSTACK_API_URL ?? '';

  async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>[]> {
    if (session === undefined) return [];
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
    if (!response.ok) throw new Error(`Unable to load ${path}`);
    const body = (await response.json()) as { items?: unknown };
    return Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  }

  async function load(active: Session) {
    setSession(active);
    try {
      const [nextMemberships, nextRoles, nextPrincipalRoles, nextPermissions, nextRolePermissions] =
        await Promise.all([
          fetchResource(active, 'group-memberships'),
          fetchResource(active, 'roles'),
          fetchResource(active, 'principal-roles'),
          fetchResource(active, 'permissions'),
          fetchResource(active, 'role-permissions'),
        ]);
      setMemberships(nextMemberships);
      setRoles(nextRoles);
      setPrincipalRoles(nextPrincipalRoles);
      setPermissions(nextPermissions);
      setRolePermissions(nextRolePermissions);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed');
    }
  }

  async function fetchResource(active: Session, path: string): Promise<Record<string, unknown>[]> {
    const response = await fetch(
      `${baseUrl}/api/v1/organizations/${encodeURIComponent(active.organizationId)}/${path}`,
      { headers: { authorization: `Bearer ${active.accessToken}` }, cache: 'no-store' },
    );
    if (!response.ok) throw new Error(`Unable to load ${path}`);
    const body = (await response.json()) as { items?: unknown };
    return Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  }

  async function submit(path: string, event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === undefined) return;
    const data = new FormData(event.currentTarget);
    try {
      await request(path, {
        method: 'POST',
        body: JSON.stringify(
          Object.fromEntries(
            ['groupId', 'principalId', 'roleId', 'permission', 'permissionId']
              .filter((name) => field(data, name) !== '')
              .map((name) => [name, field(data, name)]),
          ),
        ),
      });
      await load(session);
      event.currentTarget.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed');
    }
  }

  async function remove(path: string, payload: Record<string, string>) {
    try {
      await request(path, { method: 'DELETE', body: JSON.stringify(payload) });
      if (session !== undefined) await load(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed');
    }
  }

  if (session === undefined)
    return (
      <section className="panel narrow-panel">
        <h2>Connect an administrative session</h2>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void load({
              organizationId: field(data, 'organizationId'),
              accessToken: field(data, 'accessToken'),
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
            Load access assignments
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    );

  return (
    <div className="settings-stack">
      <section className="panel">
        <h2>Group memberships</h2>
        <form className="form-grid" onSubmit={(event) => void submit('group-memberships', event)}>
          <label>
            Group ID
            <input name="groupId" required />
          </label>
          <label>
            Principal ID
            <input name="principalId" required />
          </label>
          <button className="primary-button" type="submit">
            Add membership
          </button>
        </form>
        <ul>
          {memberships.map((item, index) => (
            <li
              key={typeof item.id === 'string' ? item.id : String(index)}
              className="settings-actions"
            >
              <span>
                {display(item.groupId)} → {display(item.principalId)}
              </span>
              <button
                type="button"
                onClick={() =>
                  void remove('group-memberships', {
                    groupId: display(item.groupId),
                    principalId: display(item.principalId),
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>Principal roles</h2>
        <form className="form-grid" onSubmit={(event) => void submit('principal-roles', event)}>
          <label>
            Principal ID
            <input name="principalId" required />
          </label>
          <label>
            Role ID
            <input name="roleId" required />
          </label>
          <button className="primary-button" type="submit">
            Assign role
          </button>
        </form>
        <ul>
          {principalRoles.map((item, index) => (
            <li
              key={typeof item.id === 'string' ? item.id : String(index)}
              className="settings-actions"
            >
              <span>
                {display(item.principalId)} → {display(item.roleId)}
              </span>
              <button
                type="button"
                onClick={() =>
                  void remove('principal-roles', {
                    principalId: display(item.principalId),
                    roleId: display(item.roleId),
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <p>{roles.length} roles available</p>
      </section>
      <section className="panel">
        <h2>Role permissions</h2>
        <form className="form-grid" onSubmit={(event) => void submit('permissions', event)}>
          <label>
            Permission (resource.action)
            <input name="permission" required />
          </label>
          <button className="primary-button" type="submit">
            Create permission
          </button>
        </form>
        <form className="form-grid" onSubmit={(event) => void submit('role-permissions', event)}>
          <label>
            Role ID
            <input name="roleId" required />
          </label>
          <label>
            Permission ID
            <input name="permissionId" required />
          </label>
          <button className="primary-button" type="submit">
            Grant permission
          </button>
        </form>
        <p>
          {permissions.length} permissions · {rolePermissions.length} grants
        </p>
      </section>
      {error && (
        <p className="error-panel" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
