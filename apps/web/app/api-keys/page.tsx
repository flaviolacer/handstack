import { OperationsClient } from '../operations-client';
import { AdminNavigation } from '../admin-navigation';
export default function ApiKeysPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/api-keys" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Governance · API Keys</div>
        <h1>API Keys</h1>
        <p>Review virtual gateway keys and their status.</p>
        <OperationsClient title="API keys" endpoint="gateway/keys" />
      </main>
    </div>
  );
}
