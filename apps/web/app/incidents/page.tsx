import { OperationsClient } from '../operations-client';
import { AdminNavigation } from '../admin-navigation';

export default function IncidentsPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/incidents" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Operations · Incidents</div>
        <h1>Incidents</h1>
        <p>Review tenant incidents, status and escalation state.</p>
        <OperationsClient title="Incidents" endpoint="incidents" />
      </main>
    </div>
  );
}
