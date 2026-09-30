import { AdminResourceClient } from '../admin-resource-client';
import { AdminNavigation } from '../admin-navigation';

export default function UsersPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/users" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Users</div>
        <h1>Users</h1>
        <p>Manage members in this organization.</p>
        <AdminResourceClient
          title="Users"
          endpoint="users"
          helpHref="/help/getting-started/overview"
          fields={[
            { name: 'username', label: 'Username' },
            { name: 'displayName', label: 'Display name' },
            { name: 'email', label: 'Email' },
          ]}
        />
      </main>
    </div>
  );
}
