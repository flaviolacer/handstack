import { CatalogClient } from '../catalog-client';
import { AdminNavigation } from '../admin-navigation';

export default function PermissionsPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/permissions" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Permissions</div>
        <h1>Permissions</h1>
        <p>Manage the organization permission catalog used by roles and policies.</p>
        <CatalogClient
          title="Permissions"
          endpoint="directory/permissions"
          createExample={'{"permission":"capability.execute"}'}
        />
      </main>
    </div>
  );
}
