import { describe, expect, it } from 'vitest';
import { HealthService } from '../src/health/health.service.js';

describe('HealthService', () => {
  it('separates liveness from dependency readiness', async () => {
    const service = new HealthService({ status: () => 'up' } as never);
    expect(service.live()).not.toHaveProperty('checks');
    expect((await service.ready()).checks).toMatchObject({ database: 'up' });
  });
});
