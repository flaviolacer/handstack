import { OperationsClient } from '../operations-client';
import { AdminNavigation } from '../admin-navigation';
export default function BudgetsPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/budgets" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Governance · Budgets</div>
        <h1>Budgets</h1>
        <p>Inspect organization budget periods and reservations.</p>
        <OperationsClient title="Budgets" endpoint="budgets" />
      </main>
    </div>
  );
}
