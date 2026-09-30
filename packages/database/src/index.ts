import type { HandStackConfig } from '@handstack/config';
import { MongoAdapter } from '@handstack/database-mongodb';
import { TypeOrmAdapter } from '@handstack/database-typeorm';
import type {
  Page,
  PageRequest,
  Repository,
  RepositoryName,
  TenantEntity,
  TransactionManager,
} from '@handstack/domain';

export interface DatabaseAdapter extends TransactionManager {
  initialize(): Promise<this>;
  repository<T extends TenantEntity>(name: RepositoryName): Repository<T>;
  /** Lists records across tenants for platform-owned discovery tasks only. */
  listAll?<T extends TenantEntity>(name: RepositoryName, page: PageRequest): Promise<Page<T>>;
  close(): Promise<void>;
}

function sqliteLocation(url: string): string | undefined {
  if (!url.startsWith('file:'))
    throw new TypeError('SQLite database URL must use the file: scheme');
  const location = url.slice('file:'.length);
  return location === ':memory:' || location.length === 0 ? undefined : location;
}

function mongoDatabaseName(url: string): string {
  const parsed = new URL(url);
  const databaseName = parsed.pathname.replace(/^\//, '');
  if (databaseName.length === 0) throw new TypeError('MongoDB URL must include a database name');
  return databaseName;
}

export function createDatabaseAdapter(config: HandStackConfig): DatabaseAdapter {
  switch (config.database.adapter) {
    case 'sqlite': {
      const location = sqliteLocation(config.database.url);
      return new TypeOrmAdapter(
        location === undefined ? { adapter: 'sqlite' } : { adapter: 'sqlite', location },
      );
    }
    case 'postgresql':
      return new TypeOrmAdapter({ adapter: 'postgresql', url: config.database.url });
    case 'mysql':
      return new TypeOrmAdapter({ adapter: 'mysql', url: config.database.url });
    case 'mariadb':
      return new TypeOrmAdapter({ adapter: 'mariadb', url: config.database.url });
    case 'sqlserver':
      return new TypeOrmAdapter({ adapter: 'sqlserver', url: config.database.url });
    case 'mongodb':
      return new MongoAdapter(config.database.url, mongoDatabaseName(config.database.url));
  }
}

export { MongoAdapter } from '@handstack/database-mongodb';
export * from './adapter-portable.js';
export * from './operations.js';
export * from './portable.js';
export { TypeOrmAdapter } from '@handstack/database-typeorm';
export { verifyRepositoryConformance } from '@handstack/domain';
