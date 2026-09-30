import Link from 'next/link';
import { DeadLettersClient } from './dead-letters-client';
import { AdminNavigation } from '../../admin-navigation';

export default function DeadLettersPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation />
        <Link href="/operations/dead-letters" aria-current="page">
          Operations
        </Link>
      </aside>
      <main className="main settings-main">
        <header className="settings-header">
          <div>
            <div className="eyebrow">Operations · Reliability</div>
            <h1>Dead-letter queues</h1>
            <p>Inspect retained failures and perform audited, tenant-scoped recovery actions.</p>
          </div>
        </header>
        <DeadLettersClient />
      </main>
    </div>
  );
}
