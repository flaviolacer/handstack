import { describe, expect, it } from 'vitest';
import { HealthService } from '../src/health/health.service.js';

describe('HealthService', () => {
  it('separates liveness from dependency readiness', async () => {
    const service = new HealthService({
      status: () => 'up',
      config: { deployment: { profile: 'compact' } },
      health: () => Promise.resolve({ healthy: true }),
    } as never);
    expect(service.live()).not.toHaveProperty('checks');
    expect((await service.ready()).checks).toMatchObject({
      database: 'up',
      databaseTransactions: 'not-configured',
      databaseVersion: 'not-configured',
      storage: 'not-configured',
      pluginRuntime: 'not-configured',
      eventBus: 'not-configured',
    });
  });

  it('reports the configured storage probe instead of masking it as unavailable', async () => {
    const service = new HealthService(
      {
        status: () => 'up',
        config: { deployment: { profile: 'compact' } },
        health: () => Promise.resolve({ healthy: true }),
      } as never,
      undefined,
      { health: () => Promise.resolve(true) } as never,
    );
    await expect(service.ready()).resolves.toMatchObject({ checks: { storage: 'up' } });
  });

  it('uses the Redis readiness result for the distributed event bus', async () => {
    const service = new HealthService(
      {
        status: () => 'up',
        config: { deployment: { profile: 'distributed' } },
        health: () => Promise.resolve({ healthy: true }),
      } as never,
      { check: () => Promise.resolve('up') } as never,
    );
    await expect(service.ready()).resolves.toMatchObject({
      checks: { redis: 'up', eventBus: 'up' },
    });
  });

  it('reports the configured plugin runtime boundary', async () => {
    const service = new HealthService(
      {
        status: () => 'up',
        config: { deployment: { profile: 'compact' } },
        health: () => Promise.resolve({ healthy: true }),
      } as never,
      undefined,
      undefined,
      { health: () => true } as never,
    );
    await expect(service.ready()).resolves.toMatchObject({ checks: { pluginRuntime: 'up' } });
  });

  it('reports replica-set readiness when the database provides the probe', async () => {
    const service = new HealthService({
      status: () => 'up',
      config: { deployment: { profile: 'compact' } },
      health: () => Promise.resolve({ healthy: true }),
      replicationHealth: () => Promise.resolve('up'),
    } as never);
    await expect(service.ready()).resolves.toMatchObject({ checks: { replication: 'up' } });
  });

  it('maps database doctor checks to readiness without exposing their details', async () => {
    const service = new HealthService({
      status: () => 'up',
      config: { deployment: { profile: 'compact' } },
      health: () =>
        Promise.resolve({
          healthy: false,
          checks: [
            { name: 'connection', status: 'pass', detail: 'secret connection detail' },
            { name: 'transactions', status: 'fail', detail: 'secret transaction detail' },
            { name: 'schema', status: 'pass', detail: 'schema detail' },
            { name: 'migrations', status: 'pass', detail: 'migration detail' },
            { name: 'indexes', status: 'pass', detail: 'index detail' },
          ],
        }),
    } as never);
    const result = await service.ready();
    expect(result.status).toBe('not-ready');
    expect(result.checks).toMatchObject({
      database: 'down',
      databaseTransactions: 'down',
      databaseSchema: 'up',
      databaseMigrations: 'up',
      databaseIndexes: 'up',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('does not report ready when a configured dependency is down', async () => {
    const service = new HealthService(
      {
        status: () => 'up',
        config: { deployment: { profile: 'compact' } },
        health: () => Promise.resolve({ healthy: true }),
      } as never,
      undefined,
      { health: () => Promise.resolve(false) } as never,
    );
    await expect(service.ready()).resolves.toMatchObject({
      status: 'not-ready',
      checks: { storage: 'down' },
    });
  });
});
