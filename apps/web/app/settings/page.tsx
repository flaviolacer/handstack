import Link from 'next/link';
import { AdminNavigation } from '../admin-navigation';
import { SettingsClient } from './settings-client';

export default function SettingsPage() {
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
            <div className="eyebrow">Settings · Organization</div>
            <h1>Organization settings</h1>
            <p>Manage tenant identity, locale, and white-label branding.</p>
          </div>
        </header>
        <SettingsClient />
      </main>
    </div>
  );
}
