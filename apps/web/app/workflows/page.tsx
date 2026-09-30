import { OperationsClient } from '../operations-client';
import { WorkflowAdminClient } from './workflow-admin-client';
import { AdminNavigation } from '../admin-navigation';

export default function WorkflowsPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/workflows" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Workflows</div>
        <h1>Workflows</h1>
        <p>Create drafts, publish workflows, and inspect governed executions.</p>
        <WorkflowAdminClient />
        <OperationsClient title="Workflow executions" endpoint="workflows" />
      </main>
    </div>
  );
}
