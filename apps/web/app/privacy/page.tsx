import { AdminNavigation } from '../admin-navigation';
import { CatalogClient } from '../catalog-client';
import { RetentionClient } from './retention-client';

export default function PrivacyPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/privacy" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Governance · Privacy</div>
        <h1>Privacy governance</h1>
        <p>
          Manage tenant-scoped data inventory, consent, processors, incidents and deletion evidence.
        </p>
        <RetentionClient />
        <CatalogClient
          title="Data inventory"
          endpoint="privacy/inventory"
          createExample={
            '{"resourceType":"conversation-messages","resourceId":"resource-id","classification":"CONFIDENTIAL","subjectIds":[]}'
          }
        />
        <CatalogClient
          title="Processing purposes"
          endpoint="privacy/purposes"
          createExample={
            '{"name":"Support","description":"Provide support","lawfulBasis":"contract"}'
          }
        />
        <CatalogClient
          title="Consent records"
          endpoint="privacy/consents"
          createExample={'{"subjectId":"subject-id","purposeId":"purpose-id"}'}
        />
        <CatalogClient
          title="Processors"
          endpoint="privacy/processors"
          createExample={'{"name":"Vendor","purpose":"Support","regions":["br-south-1"]}'}
        />
        <CatalogClient
          title="Privacy incidents"
          endpoint="privacy/incidents"
          createExample={
            '{"title":"Incident","severity":"LOW","affectedResources":["resource-id"]}'
          }
        />
        <CatalogClient title="Deletion jobs" endpoint="privacy/deletion-jobs" />
      </main>
    </div>
  );
}
