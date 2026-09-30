import {
  configLayerFromEnvironment,
  resolveConfigLayers,
  type HandStackConfig,
  type HandStackConfigLayer,
} from '@handstack/config';
import { repositoryName, uuidV7, type TenantEntity } from '@handstack/domain';
import {
  createDatabaseAdapter,
  databaseDoctor,
  type DatabaseAdapter,
  type DoctorReport,
} from '@handstack/database';
import { MongoAdapter } from '@handstack/database-mongodb';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { loadConfigFile } from './config-file.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  config: HandStackConfig;
  readonly adapter: DatabaseAdapter;
  private initialized = false;

  constructor() {
    // The checked-in config file supplies defaults; deployment environment must be
    // able to select the distributed profile and its primary adapter at startup.
    this.config = resolveConfigLayers(configLayerFromEnvironment(process.env), loadConfigFile());
    this.adapter = createDatabaseAdapter(this.config);
  }

  async onModuleInit(): Promise<void> {
    await this.adapter.initialize();
    const settings = await this.loadDatabaseSettings();
    if (settings !== undefined) {
      const effective = resolveConfigLayers(
        configLayerFromEnvironment(process.env),
        loadConfigFile(),
        settings.configuration,
      );
      if (
        effective.database.adapter !== this.config.database.adapter ||
        effective.database.url !== this.config.database.url
      ) {
        throw new Error(
          'Persisted database settings cannot change the primary database adapter or URL',
        );
      }
      this.config = effective;
    }
    this.initialized = true;
  }

  async onModuleDestroy(): Promise<void> {
    await this.adapter.close();
    this.initialized = false;
  }

  status(): 'up' | 'down' {
    return this.initialized ? 'up' : 'down';
  }

  /** Runs the adapter-level checks required before accepting traffic. */
  async health(): Promise<DoctorReport> {
    if (!this.initialized) {
      return {
        healthy: false,
        adapter: this.config.database.adapter,
        checks: [],
      };
    }
    return databaseDoctor(this.adapter);
  }

  /** Verifies MongoDB replica-set state when the selected adapter supports it. */
  async replicationHealth(): Promise<'up' | 'down' | 'not-configured'> {
    if (!(this.adapter instanceof MongoAdapter)) return 'not-configured';
    try {
      const report = (await this.adapter
        .nativeDatabase()
        .admin()
        .command({ replSetGetStatus: 1 })) as unknown as { readonly members?: unknown };
      const members = report.members;
      return Array.isArray(members) &&
        members.some(
          (member) =>
            typeof member === 'object' &&
            member !== null &&
            ['PRIMARY', 'SECONDARY'].includes(String((member as { stateStr?: unknown }).stateStr)),
        )
        ? 'up'
        : 'down';
    } catch {
      return 'down';
    }
  }

  async getDatabaseSettings(): Promise<HandStackConfigLayer> {
    return (await this.loadDatabaseSettings())?.configuration ?? {};
  }

  async updateDatabaseSettings(configuration: HandStackConfigLayer): Promise<HandStackConfigLayer> {
    const current = await this.loadDatabaseSettings();
    const effective = resolveConfigLayers(
      configLayerFromEnvironment(process.env),
      loadConfigFile(),
      configuration,
    );
    if (
      effective.database.adapter !== this.config.database.adapter ||
      effective.database.url !== this.config.database.url
    ) {
      throw new Error(
        'Persisted database settings cannot change the primary database adapter or URL',
      );
    }
    const repository = this.adapter.repository<DatabaseSettingsEntity>(
      DATABASE_SETTINGS_REPOSITORY,
    );
    const now = new Date();
    const next =
      current === undefined
        ? createDatabaseSettings(configuration)
        : { ...current, configuration, version: current.version + 1, updatedAt: now };
    if (current === undefined) await repository.insert(next);
    else await repository.update(next, current.version);
    this.config = effective;
    return configuration;
  }

  private async loadDatabaseSettings(): Promise<DatabaseSettingsEntity | undefined> {
    const page = await this.adapter
      .repository<DatabaseSettingsEntity>(DATABASE_SETTINGS_REPOSITORY)
      .list(SYSTEM_TENANT_ID, { limit: 1 });
    return page.items[0];
  }
}

const SYSTEM_TENANT_ID = 'system';
const DATABASE_SETTINGS_REPOSITORY = repositoryName('system-database-settings');

interface DatabaseSettingsEntity extends TenantEntity {
  readonly configuration: HandStackConfigLayer;
}

export function createDatabaseSettings(
  configuration: HandStackConfigLayer,
): DatabaseSettingsEntity {
  return {
    id: uuidV7(),
    tenantId: SYSTEM_TENANT_ID,
    version: 1,
    configuration,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
