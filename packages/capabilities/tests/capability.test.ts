import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { describe, expect, it } from 'vitest';
import {
  CapabilityExecutionEngine,
  InMemoryCapabilityRegistry,
  PersistentCapabilityRegistry,
} from '../src/index.js';

const base = {
  organizationId: 'org',
  slug: 'echo',
  name: 'Echo',
  description: 'Echo input',
  type: 'CUSTOM' as const,
  inputSchema: {},
  outputSchema: {},
  requiredPermissions: ['capability.execute'],
  allowedChannels: ['WEB', 'API'] as const,
  timeoutMs: 1000,
  visibility: 'ORGANIZATION' as const,
  ownerId: 'owner',
  metadata: {},
};

describe('capability execution', () => {
  it('uses one governed engine for web and API channels', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await registry.register({ ...base, handler: (input) => Promise.resolve({ echoed: input }) });
    const calls: string[] = [];
    const engine = new CapabilityExecutionEngine(registry, {
      authorize: ({ context }) => {
        calls.push(`authorize:${context.channel}`);
        return Promise.resolve();
      },
      audit: ({ outcome }) => {
        calls.push(`audit:${outcome}`);
        return Promise.resolve();
      },
    });
    await expect(
      engine.execute('echo', 'web', { organizationId: 'org', principalId: 'user', channel: 'WEB' }),
    ).resolves.toEqual({ echoed: 'web' });
    await expect(
      engine.execute('echo', 'api', { organizationId: 'org', principalId: 'user', channel: 'API' }),
    ).resolves.toEqual({ echoed: 'api' });
    expect(calls).toEqual(['authorize:WEB', 'audit:SUCCESS', 'authorize:API', 'audit:SUCCESS']);
  });

  it('fails closed for disallowed channels and releases a budget reservation on failure', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await registry.register({
      ...base,
      slug: 'failing',
      allowedChannels: ['API'],
      handler: () => Promise.reject(new Error('boom')),
    });
    let released = 0;
    const engine = new CapabilityExecutionEngine(registry, {
      authorize: () => Promise.resolve(),
      reserveBudget: () =>
        Promise.resolve(() =>
          Promise.resolve().then(() => {
            released += 1;
          }),
        ),
    });
    await expect(
      engine.execute('failing', {}, { organizationId: 'org', principalId: 'user', channel: 'WEB' }),
    ).rejects.toThrow(/unavailable/);
    await expect(
      engine.execute('failing', {}, { organizationId: 'org', principalId: 'user', channel: 'API' }),
    ).rejects.toThrow('boom');
    expect(released).toBe(1);
  });

  it('emits execution observations for successful and denied runs', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await registry.register({ ...base, handler: (input) => Promise.resolve(input) });
    const observations: string[] = [];
    const engine = new CapabilityExecutionEngine(registry, {
      authorize: ({ context }) =>
        context.principalId === 'denied' ? Promise.reject(new Error('denied')) : Promise.resolve(),
      observe: ({ operation, outcome, durationMs }) => {
        observations.push(`${operation}:${outcome}:${String(durationMs >= 0)}`);
      },
    });
    await engine.execute(
      'echo',
      {},
      { organizationId: 'org', principalId: 'user', channel: 'API' },
    );
    await expect(
      engine.execute('echo', {}, { organizationId: 'org', principalId: 'denied', channel: 'API' }),
    ).rejects.toThrow('denied');
    expect(observations).toEqual([
      'execute:success:true',
      'policy-denied:error:true',
      'execute:error:true',
    ]);
  });
});

describe('persistent capability registry', () => {
  it('persists metadata and keeps handler lookup tenant-scoped', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const registry = new PersistentCapabilityRegistry(adapter);
      await registry.register({ ...base, handler: (input) => Promise.resolve({ echoed: input }) });
      const listed = await registry.list('org', 'API');
      expect(listed).toHaveLength(1);
      await expect(registry.get('other', 'echo')).resolves.toBeUndefined();
      await expect(registry.get('org', 'echo')).resolves.toMatchObject({
        capability: { slug: 'echo' },
      });
    } finally {
      await adapter.close();
    }
  });
});
