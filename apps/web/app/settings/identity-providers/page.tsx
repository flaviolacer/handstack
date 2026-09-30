import Link from 'next/link';
import { IdentityProvidersClient } from './identity-providers-client';
import { AdminNavigation } from '../../admin-navigation';

export default function IdentityProvidersPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/settings" />
        <Link href="/settings/identity-providers">Identity Providers</Link>
      </aside>
      <main className="main settings-main">
        <header className="settings-header">
          <div>
            <div className="eyebrow">Settings · Identity</div>
            <h1>Identity Providers</h1>
            <p>Connect enterprise sign-in and enforce how members authenticate.</p>
          </div>
        </header>
        <IdentityProvidersClient />
      </main>
    </div>
  );
}
