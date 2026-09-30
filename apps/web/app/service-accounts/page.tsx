import { OperationsClient } from '../operations-client';
import { AdminNavigation } from '../admin-navigation';

export default function ServiceAccountsPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/service-accounts" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Security · Workload identities</div>
        <h1>Service accounts</h1>
        <p>Review tenant workload identities. Secrets are returned only when issued or rotated.</p>
        <OperationsClient title="Service accounts" endpoint="service-accounts" />
      </main>
    </div>
  );
}
