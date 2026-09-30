import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { RedisRuntimeService } from './redis-runtime.service.js';
import { LocalAttachmentStorage } from '../chat/attachment-storage.js';
import { PluginAdminRuntimeService } from '../plugins/plugin-admin.runtime.js';

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
    @Inject(LocalAttachmentStorage) private readonly storage?: LocalAttachmentStorage,
    @Inject(PluginAdminRuntimeService) private readonly plugins?: PluginAdminRuntimeService,
  ) {}
  live(): HealthResult {
    return { status: 'ok', service: 'handstack-api', timestamp: new Date().toISOString() };
  }

  async ready(): Promise<HealthResult> {
    const redis = await this.redis.check();
    const databaseReport = await this.database.health();
    const database = databaseReport.healthy ? 'up' : 'down';
    const reportChecks = (
      databaseReport as unknown as {
        readonly checks?: readonly { readonly name: string; readonly status: 'pass' | 'fail' }[];
      }
    ).checks;
    const databaseCheck = (name: string): 'up' | 'down' | 'not-configured' => {
      const check = reportChecks?.find((candidate) => candidate.name === name);
      if (check === undefined) return 'not-configured';
      return check.status === 'pass' ? 'up' : 'down';
    };
    const databaseTransactions = databaseCheck('transactions');
    const databaseVersion = databaseCheck('version');
    const databaseSchema = databaseCheck('schema');
    const databaseMigrations = databaseCheck('migrations');
    const databaseIndexes = databaseCheck('indexes');
    const storage =
      this.storage === undefined ||
      (typeof this.storage.isConfigured === 'function' && !this.storage.isConfigured())
        ? 'not-configured'
        : (await this.storage.health())
          ? 'up'
          : 'down';
    const distributed = this.database.config.deployment.profile === 'distributed';
    const eventBus = distributed ? redis : 'not-configured';
    const queues = distributed ? redis : 'not-configured';
    const pluginRuntime =
      this.plugins === undefined ? 'not-configured' : this.plugins.health() ? 'up' : 'down';
    const replication =
      typeof this.database.replicationHealth === 'function'
        ? await this.database.replicationHealth()
        : 'not-configured';
    const ready = [
      database,
      databaseTransactions,
      databaseVersion,
      databaseSchema,
      databaseMigrations,
      databaseIndexes,
      redis,
      storage,
      pluginRuntime,
      eventBus,
      queues,
      replication,
    ].every((check) => check !== 'down');
    return {
      status: ready ? 'ok' : 'not-ready',
      service: 'handstack-api',
      timestamp: new Date().toISOString(),
      checks: {
        database,
        databaseTransactions,
        databaseVersion,
        databaseSchema,
        databaseMigrations,
        databaseIndexes,
        redis,
        storage,
        pluginRuntime,
        eventBus,
        queues,
        replication,
      },
    };
  }
}
