import { RegistryClient } from '../registry-client';
import { CatalogClient } from '../catalog-client';
import { PluginAdminClient } from './plugin-admin-client';
import { AdminNavigation } from '../admin-navigation';

const installExample = JSON.stringify({
  manifest: {
    name: 'example.plugin',
    version: '1.0.0',
    description: 'Example plugin',
    handstack: { apiVersion: '1', capabilities: ['tools'], permissions: [] },
  },
  checksum: 'sha256:replace-with-published-checksum',
  approvedPermissions: [],
  source: { kind: 'NPM', locator: 'example-plugin' },
});

export default function PluginsPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/plugins" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Plugins</div>
        <h1>Plugins &amp; Marketplace</h1>
        <p>Inspect the governed official and community plugin catalogs.</p>
        <RegistryClient />
        <PluginAdminClient />
        <h2>Install plugin</h2>
        <CatalogClient
          title="Installed plugins"
          endpoint="plugins"
          createExample={installExample}
        />
      </main>
    </div>
  );
}
