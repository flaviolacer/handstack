import { CatalogClient } from '../catalog-client';
import { AdminNavigation } from '../admin-navigation';

export default function PoliciesPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/policies" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Governance · Policies</div>
        <h1>Policies</h1>
        <p>Create and inspect tenant-scoped authorization policies.</p>
        <CatalogClient
          title="Policies"
          endpoint="policies"
          createExample={
            '{"principalIds":["principal-id"],"resource":"capability/example","action":"execute","effect":"deny"}'
          }
        />
      </main>
    </div>
  );
}
