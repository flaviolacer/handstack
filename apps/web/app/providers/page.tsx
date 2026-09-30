import { CatalogClient } from '../catalog-client';
import { AdminNavigation } from '../admin-navigation';
export default function ProvidersPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/providers" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Providers</div>
        <h1>Providers</h1>
        <p>Review and register model provider adapters.</p>
        <CatalogClient
          title="Providers"
          endpoint="providers"
          createExample={
            '{"name":"Example provider","adapter":"openai-compatible","enabled":true,"dataClassificationAllowed":["PUBLIC"],"configuration":{}}'
          }
        />
      </main>
    </div>
  );
}
