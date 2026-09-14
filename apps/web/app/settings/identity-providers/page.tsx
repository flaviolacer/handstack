import Link from 'next/link';
import { IdentityProvidersClient } from './identity-providers-client';

export default function IdentityProvidersPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <nav className="nav" aria-label="Primary navigation">
          <Link href="/">Dashboard</Link>
          <Link href="/settings/identity-providers" aria-current="page">
            Identity Providers
          </Link>
          <Link href="/help">Help Center</Link>
        </nav>
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
