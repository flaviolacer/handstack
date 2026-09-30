import { OperationsClient } from '../operations-client';
import { AdminNavigation } from '../admin-navigation';

export default function AccessRequestsPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/access-requests" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Governance · Access</div>
        <h1>Access requests</h1>
        <p>Review temporary access requests and grants.</p>
        <OperationsClient title="Access requests" endpoint="access-requests" />
      </main>
    </div>
  );
}
