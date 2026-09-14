import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { RepositoryAuditSink } from '@handstack/audit';
import { uuidV7 } from '@handstack/domain';

const databaseUrl = process.env.HANDSTACK_DATABASE_URL;
if (databaseUrl === undefined) throw new Error('HANDSTACK_DATABASE_URL is required');
const adapter = createDatabaseAdapter(defineConfig({
  database: { adapter: 'sqlite', url: databaseUrl },
}));
await adapter.initialize();
try {
  const sink = new RepositoryAuditSink((name) => adapter.repository(name));
  await sink.append({
    id: uuidV7(),
    timestamp: new Date('2026-09-09T12:00:00.000Z'),
    organizationId: 'org-e2e',
    actorId: 'system',
    actorType: 'SYSTEM',
    action: 'E2E_CHECK',
    resourceType: 'audit',
    decision: 'ALLOW',
    metadata: { model: 'test-model' },
  });
} finally {
  await adapter.close();
}
console.log('seeded');
