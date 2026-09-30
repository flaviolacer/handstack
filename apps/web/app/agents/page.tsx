import { AgentsClient } from './agents-client';
import { AdminNavigation } from '../admin-navigation';
export default function AgentsPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/agents" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Agents</div>
        <h1>Agents</h1>
        <p>Create agents, manage immutable versions, and publish the version used by runtime.</p>
        <AgentsClient />
      </main>
    </div>
  );
}
