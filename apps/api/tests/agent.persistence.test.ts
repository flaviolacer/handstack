import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntimeService } from '../src/agents/agent-runtime.service.js';
import { DatabaseService } from '../src/database/database.service.js';

describe('durable agent runtime SQLite round-trip', () => {
  let database: DatabaseService | undefined;
  afterEach(async () => {
    await database?.onModuleDestroy();
    database = undefined;
    delete process.env.HANDSTACK_DATABASE_ADAPTER;
    delete process.env.HANDSTACK_DATABASE_URL;
  });

  it('persists agent versions and publication state across runtime instances', async () => {
    process.env.HANDSTACK_DATABASE_ADAPTER = 'sqlite';
    process.env.HANDSTACK_DATABASE_URL = 'file::memory:';
    database = new DatabaseService();
    await database.onModuleInit();
    const runtime = new AgentRuntimeService(database);
    const agent = await runtime.create({
      organizationId: 'agent-persist',
      slug: 'support-agent',
      name: 'Support',
    });
    const first = await runtime.createVersion({
      organizationId: 'agent-persist',
      agentId: agent.id,
      model: 'model-a',
      systemPrompt: 'A',
    });
    await runtime.publish('agent-persist', agent.id, first.id);
    const secondRuntime = new AgentRuntimeService(database);
    const listed = await secondRuntime.list('agent-persist');
    expect(listed).toMatchObject([{ id: agent.id, slug: 'support-agent' }]);
    expect(listed[0]?.createdAt).toBeInstanceOf(Date);
    const versions = await secondRuntime.versionsFor('agent-persist', agent.id);
    expect(versions).toMatchObject([{ id: first.id, status: 'PUBLISHED' }]);
    expect(versions[0]?.createdAt).toBeInstanceOf(Date);
  });
});
