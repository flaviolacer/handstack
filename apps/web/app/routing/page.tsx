import { CatalogClient } from '../catalog-client';
import { AdminNavigation } from '../admin-navigation';

const example = JSON.stringify({
  name: 'Default fallback',
  strategy: 'fallback',
  candidates: [{ modelDefinitionId: 'model-id', providerId: 'provider-id', priority: 1 }],
});

export default function RoutingPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/routing" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Models</div>
        <h1>Model routing</h1>
        <p>Manage tenant-scoped policies that select governed model candidates.</p>
        <CatalogClient
          title="Routing policies"
          endpoint="routing-policies"
          createExample={example}
        />
      </main>
    </div>
  );
}
