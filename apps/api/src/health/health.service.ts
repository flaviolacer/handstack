import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { RedisRuntimeService } from './redis-runtime.service.js';

export interface HealthResult {
  readonly status: 'ok' | 'not-ready';
  readonly service: 'handstack-api';
  readonly timestamp: string;
  readonly checks?: Readonly<Record<string, 'up' | 'down' | 'not-configured'>>;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RedisRuntimeService)
    private readonly redis: RedisRuntimeService = new RedisRuntimeService(),
  ) {}
  live(): HealthResult {
    return { status: 'ok', service: 'handstack-api', timestamp: new Date().toISOString() };
  }

  async ready(): Promise<HealthResult> {
    const redis = await this.redis.check();
    const database = this.database.status();
    return {
      status: database === 'up' && redis !== 'down' ? 'ok' : 'not-ready',
      service: 'handstack-api',
      timestamp: new Date().toISOString(),
      checks: {
        database,
        redis,
        storage: 'not-configured',
      },
    };
  }
}
