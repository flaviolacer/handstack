import { AdminResourceClient } from '../admin-resource-client';
import { AdminNavigation } from '../admin-navigation';
import { DirectoryAssignmentsClient } from '../directory-assignments-client';

export default function GroupsPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/groups" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Groups</div>
        <h1>Groups</h1>
        <p>Manage organization groups and membership boundaries.</p>
        <AdminResourceClient
          title="Groups"
          endpoint="groups"
          helpHref="/help/getting-started/overview"
          fields={[
            { name: 'name', label: 'Name' },
            { name: 'description', label: 'Description' },
          ]}
        />
        <DirectoryAssignmentsClient />
      </main>
    </div>
  );
}
