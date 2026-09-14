import { describe, expect, it } from 'vitest';
import { configFromEnvironment, defineConfig } from '../src/index.js';

describe('HandStack configuration', () => {
  it('uses compact SQLite defaults and opt-in telemetry', () => {
    expect(defineConfig({})).toMatchObject({
      deployment: { profile: 'compact' },
      database: { adapter: 'sqlite' },
      telemetry: { enabled: false },
    });
  });

  it('selects exactly one primary adapter from the environment', () => {
    expect(
      configFromEnvironment({
        HANDSTACK_DATABASE_ADAPTER: 'mongodb',
        HANDSTACK_DATABASE_URL: 'mongodb://localhost/handstack',
      }).database,
    ).toEqual({ adapter: 'mongodb', url: 'mongodb://localhost/handstack' });
  });

  it('rejects unsupported adapters and invalid ports', () => {
    expect(() => configFromEnvironment({ HANDSTACK_DATABASE_ADAPTER: 'oracle' })).toThrow();
    expect(() => configFromEnvironment({ HANDSTACK_API_PORT: 'invalid' })).toThrow('Invalid port');
  });

  it('accepts an optional distributed Redis URL from the environment', () => {
    expect(
      configFromEnvironment({ HANDSTACK_REDIS_URL: 'redis://localhost:6379/0' }).queue,
    ).toMatchObject({ redisUrl: 'redis://localhost:6379/0', topology: 'standalone' });
  });

  it('requires Redis for distributed deployments and exposes isolated namespaces', () => {
    expect(() => configFromEnvironment({ HANDSTACK_DEPLOYMENT_PROFILE: 'distributed' })).toThrow(
      'requires a Redis URL',
    );
    const distributed = configFromEnvironment({
      HANDSTACK_DEPLOYMENT_PROFILE: 'distributed',
      HANDSTACK_REDIS_URL: 'redis+sentinel://redis-sentinel:26379/0',
    });
    expect(distributed.deployment.profile).toBe('distributed');
    expect(distributed.queue.redisUrl).toBe('redis+sentinel://redis-sentinel:26379/0');
    expect(defineConfig({}).queue.namespaces).toEqual({
      cache: 'handstack:cache',
      rateLimit: 'handstack:rate-limit',
      queues: 'handstack:queues',
      streams: 'handstack:streams',
    });
  });

  it('accepts HTTPS notification endpoints and rejects HTTP', () => {
    expect(
      configFromEnvironment({
        HANDSTACK_NOTIFICATION_SLACK_ENDPOINT: 'https://hooks.example.test/slack',
      }).notifications,
    ).toEqual({ slackEndpoint: 'https://hooks.example.test/slack' });
    expect(() =>
      configFromEnvironment({ HANDSTACK_NOTIFICATION_SLACK_ENDPOINT: 'http://localhost/hook' }),
    ).toThrow('HTTPS');
  });

  it('rejects a URL whose scheme does not match the selected adapter', () => {
    expect(() =>
      defineConfig({ database: { adapter: 'mongodb', url: 'file:./handstack.db' } }),
    ).toThrow('incompatible');
    expect(() =>
      defineConfig({ database: { adapter: 'sqlite', url: 'postgresql://localhost/handstack' } }),
    ).toThrow('incompatible');
  });
});
