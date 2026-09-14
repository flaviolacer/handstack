import type {
  Repository,
  RepositoryName,
  TenantEntity,
  TransactionContext,
  TransactionManager,
  TransactionOptions,
} from '@handstack/domain';
import { DataSource, type DataSourceOptions, type EntityManager } from 'typeorm';
import { entityRecordSchema } from './entity-record.js';
import { InitialSchema1735689600000 } from './migrations/initial-schema.js';
import { PortableImport1735689600001 } from './migrations/portable-import.js';
import { portableImportStateSchema, portableStagedRecordSchema } from './portable-entity.js';
import { TypeOrmRepository } from './repository.js';

export type SqlAdapterConfig =
  | { readonly adapter: 'sqlite'; readonly location?: string }
  | {
      readonly adapter: 'postgresql' | 'mysql' | 'mariadb' | 'sqlserver';
      readonly url: string;
    };

function options(config: SqlAdapterConfig): DataSourceOptions {
  const common = {
    entities: [entityRecordSchema, portableImportStateSchema, portableStagedRecordSchema],
    migrations: [InitialSchema1735689600000, PortableImport1735689600001],
    synchronize: false,
    migrationsRun: true,
  };
  switch (config.adapter) {
    case 'sqlite':
      return config.location === undefined
        ? { ...common, type: 'sqljs' }
        : { ...common, type: 'sqljs', location: config.location, autoSave: true };
    case 'postgresql':
      return { ...common, type: 'postgres', url: config.url };
    case 'mysql':
      return { ...common, type: 'mysql', url: config.url };
    case 'mariadb':
      return { ...common, type: 'mariadb', url: config.url };
    case 'sqlserver':
      return {
        ...common,
        type: 'mssql',
        url: config.url,
        ...(process.env.HANDSTACK_TEST_SQL_TRUST_CERT === 'true'
          ? { options: { encrypt: false, trustServerCertificate: true } }
          : {}),
      };
  }
}

const isolationLevels = {
  'read-committed': 'READ COMMITTED',
  'repeatable-read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
} as const;

class TypeOrmTransactionContext implements TransactionContext {
  constructor(private readonly manager: EntityManager) {}
  repository<T extends TenantEntity>(name: RepositoryName): Repository<T> {
    return new TypeOrmRepository<T>(this.manager, name);
  }
}

export class TypeOrmAdapter implements TransactionManager {
  readonly dataSource: DataSource;
  constructor(config: SqlAdapterConfig) {
    this.dataSource = new DataSource(options(config));
  }
  async initialize(): Promise<this> {
    await this.dataSource.initialize();
    return this;
  }
  repository<T extends TenantEntity>(name: RepositoryName): Repository<T> {
    return new TypeOrmRepository<T>(this.dataSource.manager, name);
  }
  async run<T>(
    operation: (context: TransactionContext) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    return this.dataSource.transaction(
      isolationLevels[options?.isolation ?? 'serializable'],
      (manager) => operation(new TypeOrmTransactionContext(manager)),
    );
  }
  async close(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
