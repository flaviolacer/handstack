import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { WebhookRuntimeService } from '../src/webhooks/webhook-runtime.service.js';
import { AuditRuntimeService } from '../src/audit/audit-runtime.service.js';

describe('tenant webhook runtime boundary', () => {
  let database: DatabaseService | undefined;
  afterEach(async () => {
    await database?.onModuleDestroy();
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
  });

  it('persists dead letters and replays them through the configured tenant endpoint', async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    database = new DatabaseService();
    await database.onModuleInit();
    let healthy = false;
    let sends = 0;
    const audit = new AuditRuntimeService();
    const runtime = new WebhookRuntimeService(database, audit);
    await runtime.configure('org', 'https://example.test/hook', '1234567890123456', undefined, {
      send: () => {
        sends += 1;
        return healthy ? Promise.resolve() : Promise.reject(new Error('offline'));
      },
    });
    await expect(
      runtime.dispatch({ organizationId: 'org', id: 'd1', event: 'user.created', payload: {} }),
    ).resolves.toMatchObject({ status: 'DEAD_LETTERED' });
    await expect(audit.query('org', 'WEBHOOK_DEAD_LETTERED')).resolves.toHaveLength(1);
    expect(await runtime.deadLetters('org')).toHaveLength(1);
    healthy = true;
    await expect(runtime.replay('org', 'd1')).resolves.toMatchObject({ status: 'DELIVERED' });
    expect(sends).toBe(4);
  });
});
