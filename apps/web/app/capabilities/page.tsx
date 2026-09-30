import { CatalogClient } from '../catalog-client';
import { AdminNavigation } from '../admin-navigation';
export default function CapabilitiesPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/capabilities" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Capabilities</div>
        <h1>Capabilities</h1>
        <p>Inspect and register governed capability descriptors for this organization.</p>
        <CatalogClient
          title="Capabilities"
          endpoint="capabilities"
          createExample={
            '{"slug":"example-capability","name":"Example capability","description":"Replace with a governed capability descriptor","type":"TOOL","inputSchema":{"type":"object"},"outputSchema":{"type":"object"},"requiredPermissions":["capability.execute"],"allowedChannels":["API"],"timeoutMs":30000,"visibility":"PRIVATE","ownerId":"principal-id","metadata":{}}'
          }
        />
      </main>
    </div>
  );
}
