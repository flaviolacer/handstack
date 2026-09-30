import { CatalogClient } from '../catalog-client';
import { AdminNavigation } from '../admin-navigation';

const example = JSON.stringify({
  provider: 'provider-id',
  model: 'model-name',
  inputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0,
  effectiveFrom: new Date().toISOString(),
});

export default function PricingPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/pricing" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Governance</div>
        <h1>Model pricing</h1>
        <p>Manage versioned tenant pricing used by budget reservations and the gateway.</p>
        <CatalogClient title="Model pricing" endpoint="pricing/models" createExample={example} />
      </main>
    </div>
  );
}
