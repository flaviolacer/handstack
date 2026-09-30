import Link from 'next/link';
import { DashboardClient } from './dashboard-client';
import { AdminNavigation } from './admin-navigation';

export default function HomePage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/" />
      </aside>
      <main className="main">
        <section className="hero">
          <div className="eyebrow">Build once · Govern once · Expose everywhere</div>
          <h1>Every AI capability, under one policy.</h1>
          <p>
            HandStack unifies the AI workspace, agent runtime, gateway, MCP, plugins, and governance
            around one central abstraction: Capability.
          </p>
          <div className="cards">
            <Link className="card" href="/chat">
              <strong>Chat</strong>
              <p>Talk to any published model through the governed runtime.</p>
            </Link>
            <Link className="card" href="/help/getting-started/overview">
              <strong>Get started</strong>
              <p>Verify the platform foundation.</p>
            </Link>
            <Link className="card" href="/help/user/help-center">
              <strong>Help Center</strong>
              <p>Browse packaged, offline guidance.</p>
            </Link>
          </div>
          <DashboardClient />
        </section>
      </main>
    </div>
  );
}
