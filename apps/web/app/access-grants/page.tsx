import { AccessGrantsClient } from './access-grants-client';
import { AdminNavigation } from '../admin-navigation';

export default function AccessGrantsPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/access-grants" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Governance · Access</div>
        <h1>Access grants</h1>
        <p>Inspect and revoke temporary and permanent grants for the organization.</p>
        <AccessGrantsClient />
      </main>
    </div>
  );
}
