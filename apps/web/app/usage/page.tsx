import { AdminNavigation } from '../admin-navigation';
import { UsageDashboardClient } from './usage-dashboard-client';
export default function UsagePage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/usage" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Governance · Usage</div>
        <h1>Usage</h1>
        <p>Inspect tenant usage and cost data.</p>
        <UsageDashboardClient />
      </main>
    </div>
  );
}
