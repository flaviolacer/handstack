import { McpClientAdmin } from './mcp-client-admin';
import { AdminNavigation } from '../admin-navigation';

export default function McpPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/mcp" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · MCP</div>
        <h1>Model Context Protocol</h1>
        <p>
          The authenticated MCP endpoint is available at <code>/mcp/:organizationId</code>. Server
          publishing and client connections remain governed by the capability and permission
          registries.
        </p>
        <section className="panel">
          <h2>Available integration</h2>
          <dl>
            <dt>Transport</dt>
            <dd>HTTP JSON-RPC</dd>
            <dt>Endpoint</dt>
            <dd>
              <code>POST /mcp/:organizationId</code>
            </dd>
            <dt>Required permission</dt>
            <dd>
              <code>capability.execute</code>
            </dd>
          </dl>
          <p>
            Use the organization ID and access token from an administrative session to connect an
            MCP client.
          </p>
        </section>
        <McpClientAdmin />
      </main>
    </div>
  );
}
