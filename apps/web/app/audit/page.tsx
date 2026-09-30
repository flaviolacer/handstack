import { OperationsClient } from '../operations-client';
import { AdminNavigation } from '../admin-navigation';
export default function AuditPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/audit" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Governance · Audit</div>
        <h1>Audit log</h1>
        <p>Review append-only audit events for this organization.</p>
        <OperationsClient title="Audit events" endpoint="audit" />
      </main>
    </div>
  );
}
