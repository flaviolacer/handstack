import { CatalogClient } from '../catalog-client';
import { AdminNavigation } from '../admin-navigation';

export default function KnowledgePage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HandStack</div>
        <AdminNavigation current="/knowledge" />
      </aside>
      <main className="main settings-main">
        <div className="eyebrow">Administration · Knowledge</div>
        <h1>Knowledge bases</h1>
        <p>
          Review tenant-scoped Knowledge/RAG bases. Documents and ingestion remain governed by ACL
          and retention policies.
        </p>
        <CatalogClient
          title="Knowledge bases"
          endpoint="knowledge/bases"
          createExample={
            '{"name":"Support knowledge","description":"Approved support corpus","chunkSize":1000,"chunkOverlap":100,"strategy":"PARAGRAPH","metadataExtraction":true,"embeddingModel":"embedding-model"}'
          }
        />
      </main>
    </div>
  );
}
