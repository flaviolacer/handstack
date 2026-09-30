import { SecretsClient } from './secrets-client';
import { AdminNavigation } from '../admin-navigation';

export default function SecretsPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/secrets" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Security · Secret vault</div>
        <h1>Secrets</h1>
        <p>Manage tenant-scoped secret references. Values are never displayed after submission.</p>
        <SecretsClient />
      </main>
    </div>
  );
}
