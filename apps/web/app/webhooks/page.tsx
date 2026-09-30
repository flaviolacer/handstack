import { OperationsClient } from '../operations-client';
import { AdminNavigation } from '../admin-navigation';

export default function WebhooksPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/webhooks" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Operations · Webhooks</div>
        <h1>Webhooks</h1>
        <p>Inspect webhook deliveries and retry state.</p>
        <OperationsClient title="Webhook deliveries" endpoint="webhooks/deliveries" />
      </main>
    </div>
  );
}
