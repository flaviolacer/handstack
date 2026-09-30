'use client';

import { useState, type SyntheticEvent } from 'react';

export function McpClientAdmin() {
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState('');
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    const organization = field('organizationId');
    const token = field('accessToken');
    const id = field('id');
    const name = field('name');
    const url = field('url');
    if ([organization, token, id, name, url].some((value) => value === '')) return;
    const body = { id, name, transport: 'STREAMABLE_HTTP', url, allowedPermissions: ['mcp.use'] };
    const response = await fetch(`/mcp/servers/${encodeURIComponent(organization)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      setError('Unable to register MCP server');
      return;
    }
    setResult(await response.json());
    setError('');
  }
  async function discover(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    const organization = field('organizationId');
    const token = field('accessToken');
    const serverId = field('serverId');
    if ([organization, token, serverId].some((value) => value === '')) return;
    const response = await fetch(
      `/mcp/servers/${encodeURIComponent(organization)}/${encodeURIComponent(serverId)}/discover`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      setError('Unable to discover MCP tools');
      return;
    }
    setResult(await response.json());
    setError('');
  }
  async function saveCredential(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };
    const organization = field('credentialOrganizationId');
    const token = field('credentialAccessToken');
    const serverId = field('credentialServerId');
    const type = field('credentialType');
    const secret = field('credentialSecret');
    if ([organization, token, serverId, type, secret].some((value) => value === '')) return;
    const response = await fetch(
      `/mcp/servers/${encodeURIComponent(organization)}/${encodeURIComponent(serverId)}/credentials`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type, secret }),
      },
    );
    if (!response.ok) {
      setError('Unable to store MCP credential');
      return;
    }
    setResult({ saved: true, serverId, type });
    setError('');
    event.currentTarget.reset();
  }
  return (
    <section className="panel">
      <h2>Register an MCP client server</h2>
      <form className="form-grid" onSubmit={(event) => void submit(event)}>
        <label>
          Organization ID
          <input name="organizationId" required />
        </label>
        <label>
          Bearer access token
          <input name="accessToken" type="password" required />
        </label>
        <label>
          Server ID
          <input name="id" required />
        </label>
        <label>
          Name
          <input name="name" required />
        </label>
        <label>
          HTTPS URL
          <input name="url" type="url" required />
        </label>
        <button className="primary-button" type="submit">
          Register server
        </button>
      </form>
      <h2>Store per-user credential</h2>
      <form className="form-grid" onSubmit={(event) => void saveCredential(event)}>
        <label>
          Organization ID
          <input name="credentialOrganizationId" required />
        </label>
        <label>
          Bearer access token
          <input name="credentialAccessToken" type="password" required />
        </label>
        <label>
          Server ID
          <input name="credentialServerId" required />
        </label>
        <label>
          Credential type
          <select name="credentialType" defaultValue="BEARER">
            <option>BEARER</option>
            <option>API_KEY</option>
            <option>OAUTH2</option>
            <option>OIDC</option>
            <option>CUSTOM_HEADERS</option>
          </select>
        </label>
        <label>
          Secret or JSON headers
          <input name="credentialSecret" type="password" required />
        </label>
        <button className="primary-button" type="submit">
          Save encrypted credential
        </button>
      </form>
      <h2>Discover tools</h2>
      <form className="form-grid" onSubmit={(event) => void discover(event)}>
        <label>
          Organization ID
          <input name="organizationId" required />
        </label>
        <label>
          Bearer access token
          <input name="accessToken" type="password" required />
        </label>
        <label>
          Server ID
          <input name="serverId" required />
        </label>
        <button className="primary-button" type="submit">
          Discover
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {result !== undefined && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </section>
  );
}
