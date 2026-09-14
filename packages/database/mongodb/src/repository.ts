import type { Page, PageRequest, Repository, TenantEntity } from '@handstack/domain';
import {
  MongoServerError,
  type ClientSession,
  type Collection,
  type Document,
  type Filter,
} from 'mongodb';

export class MongoPersistenceConflictError extends Error {
  readonly code = 'persistence_conflict';
  constructor(message: string) {
    super(message);
    this.name = 'MongoPersistenceConflictError';
  }
}

export class MongoPersistenceConcurrencyError extends Error {
  readonly code = 'persistence_concurrency_conflict';
  constructor(message: string) {
    super(message);
    this.name = 'MongoPersistenceConcurrencyError';
  }
}

export interface EntityDocument extends Document {
  repositoryName: string;
  tenantId: string;
  id: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  payload: Document;
}

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id })).toString('base64url');
}
function decodeCursor(cursor: string): string {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id?: unknown };
    if (typeof value.id !== 'string') throw new Error();
    return value.id;
  } catch {
    throw new TypeError('Invalid repository cursor');
  }
}

function toDocument(entity: TenantEntity, repositoryName: string): EntityDocument {
  return {
    repositoryName,
    tenantId: entity.tenantId,
    id: entity.id,
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    payload: Object.fromEntries(
      Object.entries(entity).filter(
        ([key]) => !['id', 'tenantId', 'version', 'createdAt', 'updatedAt'].includes(key),
      ),
    ),
  };
}

function fromDocument(document: EntityDocument): TenantEntity {
  return {
    ...document.payload,
    id: document.id,
    tenantId: document.tenantId,
    version: document.version,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

export class MongoRepository<T extends TenantEntity> implements Repository<T> {
  constructor(
    private readonly collection: Collection<EntityDocument>,
    private readonly name: string,
    private readonly session?: ClientSession,
  ) {}
  private operationOptions(): { session: ClientSession } | Record<string, never> {
    return this.session === undefined ? {} : { session: this.session };
  }
  async findById(tenantId: string, id: string): Promise<T | undefined> {
    const found = await this.collection.findOne(
      { repositoryName: this.name, tenantId, id },
      this.operationOptions(),
    );
    return found === null ? undefined : (fromDocument(found) as T);
  }
  async list(tenantId: string, page: PageRequest): Promise<Page<T>> {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 200)
      throw new RangeError('Page limit must be between 1 and 200');
    const direction = page.direction ?? 'forward';
    const filter: Filter<EntityDocument> = { repositoryName: this.name, tenantId };
    if (page.cursor !== undefined)
      filter.id = { [direction === 'forward' ? '$gt' : '$lt']: decodeCursor(page.cursor) };
    const documents = await this.collection
      .find(filter, this.operationOptions())
      .sort({ id: direction === 'forward' ? 1 : -1 })
      .limit(page.limit + 1)
      .toArray();
    const hasMore = documents.length > page.limit;
    const selected = documents.slice(0, page.limit);
    const last = selected.at(-1);
    return {
      items: selected.map((item) => fromDocument(item) as T),
      ...(hasMore && last !== undefined ? { nextCursor: encodeCursor(last.id) } : {}),
    };
  }
  async insert(entity: T): Promise<T> {
    try {
      await this.collection.insertOne(toDocument(entity, this.name), this.operationOptions());
      return entity;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new MongoPersistenceConflictError(`Entity ${entity.id} already exists`);
      throw error;
    }
  }
  async update(entity: T, expectedVersion: number): Promise<T> {
    const next = toDocument(entity, this.name);
    const result = await this.collection.replaceOne(
      {
        repositoryName: this.name,
        tenantId: entity.tenantId,
        id: entity.id,
        version: expectedVersion,
      },
      next,
      this.operationOptions(),
    );
    if (result.matchedCount !== 1)
      throw new MongoPersistenceConcurrencyError(`Entity ${entity.id} version changed`);
    return entity;
  }
  async delete(tenantId: string, id: string, expectedVersion: number): Promise<boolean> {
    const result = await this.collection.deleteOne(
      { repositoryName: this.name, tenantId, id, version: expectedVersion },
      this.operationOptions(),
    );
    if (result.deletedCount === 0 && (await this.findById(tenantId, id)) !== undefined)
      throw new MongoPersistenceConcurrencyError(`Entity ${id} version changed`);
    return result.deletedCount === 1;
  }
}
