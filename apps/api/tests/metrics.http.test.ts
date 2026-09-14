import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../src/main.js';

describe('API metrics HTTP contract', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApplication();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes canonical metrics without request payloads', async () => {
    await app.inject({ method: 'GET', url: '/health/live' });
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('# TYPE handstack_requests_total counter');
    expect(response.body).toContain('handstack_requests_total{method="GET",status="200"} 1');
    expect(response.body).toContain('# TYPE handstack_llm_requests_total counter');
    expect(response.body).toContain('# TYPE handstack_event_loop_lag_seconds gauge');
    expect(response.body).toContain('# TYPE handstack_queue_oldest_age_seconds gauge');
    expect(response.body).not.toContain('authorization');
    expect(response.body).not.toContain('payload');
  });
});
