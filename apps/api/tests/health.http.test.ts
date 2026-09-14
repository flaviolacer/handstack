import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApplication } from '../src/main.js';
import type { HealthResult } from '../src/health/health.service.js';

describe('health HTTP contract', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes independent live and ready probes', async () => {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(live.json()).not.toHaveProperty('checks');
    expect(ready.statusCode).toBe(200);
    expect(ready.json<HealthResult>().checks).toMatchObject({ database: 'up' });
  });
});
