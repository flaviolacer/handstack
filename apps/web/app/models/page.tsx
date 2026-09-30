import { CatalogClient } from '../catalog-client';
import { AdminNavigation } from '../admin-navigation';
export default function ModelsPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/models" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Models</div>
        <h1>Models</h1>
        <p>Review and register provider models.</p>
        <CatalogClient
          title="Models"
          endpoint="models"
          createExample={
            '{"displayName":"Example model","providerId":"provider-id","providerModel":"model-name","capabilities":["chat"],"contextWindow":128000,"pricing":{"inputPerMillion":0,"outputPerMillion":0,"currency":"USD"}}'
          }
        />
      </main>
    </div>
  );
}
