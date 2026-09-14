import type {
  Repository,
  RepositoryName,
  TenantEntity,
  TransactionContext,
  TransactionManager,
  TransactionOptions,
} from '@handstack/domain';
import { MongoClient, type ClientSession, type Db } from 'mongodb';
import { runDocumentMigrations } from './migrations.js';
import { MongoRepository, type EntityDocument } from './repository.js';
import { entityCollectionName } from './schema.js';

class MongoTransactionContext implements TransactionContext {
  constructor(
    private readonly database: Db,
    private readonly session: ClientSession,
  ) {}
  repository<T extends TenantEntity>(name: RepositoryName): Repository<T> {
    return new MongoRepository<T>(
      this.database.collection<EntityDocument>(entityCollectionName),
      name,
      this.session,
    );
  }
}

export class MongoAdapter implements TransactionManager {
  private readonly client: MongoClient;
  private database: Db | undefined;
  constructor(
    private readonly url: string,
    private readonly databaseName: string,
  ) {
    this.client = new MongoClient(url);
  }
  async initialize(): Promise<this> {
    await this.client.connect();
    this.database = this.client.db(this.databaseName);
    await runDocumentMigrations(this.database);
    return this;
  }
  repository<T extends TenantEntity>(name: RepositoryName): Repository<T> {
    return new MongoRepository<T>(
      this.requireDatabase().collection<EntityDocument>(entityCollectionName),
      name,
    );
  }
  async run<T>(
    operation: (context: TransactionContext) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(
        () => operation(new MongoTransactionContext(this.requireDatabase(), session)),
        options?.timeoutMs === undefined ? {} : { maxCommitTimeMS: options.timeoutMs },
      );
    } finally {
      await session.endSession();
    }
  }
  async close(): Promise<void> {
    await this.client.close();
    this.database = undefined;
  }
  nativeDatabase(): Db {
    return this.requireDatabase();
  }
  nativeClient(): MongoClient {
    return this.client;
  }
  private requireDatabase(): Db {
    if (this.database === undefined) throw new Error('MongoAdapter is not initialized');
    return this.database;
  }
}
