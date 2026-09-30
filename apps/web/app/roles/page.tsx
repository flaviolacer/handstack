import { AdminResourceClient } from '../admin-resource-client';
import { AdminNavigation } from '../admin-navigation';

export default function RolesPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/roles" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Roles</div>
        <h1>Roles</h1>
        <p>Manage roles used by the organization permission model.</p>
        <AdminResourceClient
          title="Roles"
          endpoint="roles"
          helpHref="/help/getting-started/overview"
          fields={[
            { name: 'name', label: 'Name' },
            { name: 'description', label: 'Description' },
          ]}
        />
      </main>
    </div>
  );
}
