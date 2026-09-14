import type { Page, PageRequest, Repository, TenantEntity } from '@handstack/domain';
import type { EntityManager } from 'typeorm';
import { entityRecordSchema, type EntityRecord } from './entity-record.js';
import { PersistenceConcurrencyError, PersistenceConflictError } from './errors.js';

interface CursorValue {
  readonly id: string;
}

function encodeCursor(record: EntityRecord): string {
  return Buffer.from(JSON.stringify({ id: record.id })).toString('base64url');
}

function decodeCursor(cursor: string): CursorValue {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<CursorValue>;
    if (typeof value.id !== 'string') throw new Error();
    return { id: value.id };
  } catch {
    throw new TypeError('Invalid repository cursor');
  }
}

function serialize(entity: TenantEntity): EntityRecord {
  const payload = Object.fromEntries(
    Object.entries(entity).filter(
      ([key]) => !['id', 'tenantId', 'version', 'createdAt', 'updatedAt'].includes(key),
    ),
  );
  return {
    repositoryName: '',
    tenantId: entity.tenantId,
    id: entity.id,
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    payload: JSON.stringify(payload),
  };
}

function deserialize(record: EntityRecord): TenantEntity {
  return {
    ...(JSON.parse(record.payload) as object),
    id: record.id,
    tenantId: record.tenantId,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class TypeOrmRepository<T extends TenantEntity> implements Repository<T> {
  constructor(
    private readonly manager: EntityManager,
    private readonly name: string,
  ) {}

  async findById(tenantId: string, id: string): Promise<T | undefined> {
    const record = await this.manager.findOne(entityRecordSchema, {
      where: { repositoryName: this.name, tenantId, id },
    });
    return record === null ? undefined : (deserialize(record) as T);
  }

  async list(tenantId: string, page: PageRequest): Promise<Page<T>> {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 200)
      throw new RangeError('Page limit must be between 1 and 200');
    const direction = page.direction ?? 'forward';
    const operator = direction === 'forward' ? '>' : '<';
    const order = direction === 'forward' ? 'ASC' : 'DESC';
    const query = this.manager
      .createQueryBuilder(entityRecordSchema, 'entity')
      .where('entity.repository_name = :name', { name: this.name })
      .andWhere('entity.tenant_id = :tenantId', { tenantId })
      .orderBy('entity.id', order)
      .take(page.limit + 1);
    if (page.cursor !== undefined) {
      const cursor = decodeCursor(page.cursor);
      query.andWhere(`entity.id ${operator} :cursorId`, { cursorId: cursor.id });
    }
    const records = await query.getMany();
    const hasMore = records.length > page.limit;
    const selected = records.slice(0, page.limit);
    const last = selected.at(-1);
    return {
      items: selected.map((record) => deserialize(record) as T),
      ...(hasMore && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  async insert(entity: T): Promise<T> {
    try {
      const record = serialize(entity);
      record.repositoryName = this.name;
      await this.manager.insert(entityRecordSchema, record);
      return entity;
    } catch (error) {
      throw new PersistenceConflictError(
        `Entity ${entity.id} already exists: ${error instanceof Error ? error.message : 'write conflict'}`,
      );
    }
  }

  async update(entity: T, expectedVersion: number): Promise<T> {
    const next = serialize(entity);
    next.repositoryName = this.name;
    const result = await this.manager.update(
      entityRecordSchema,
      {
        repositoryName: this.name,
        tenantId: entity.tenantId,
        id: entity.id,
        version: expectedVersion,
      },
      next,
    );
    if (result.affected !== 1)
      throw new PersistenceConcurrencyError(`Entity ${entity.id} version changed`);
    return entity;
  }

  async delete(tenantId: string, id: string, expectedVersion: number): Promise<boolean> {
    const result = await this.manager.delete(entityRecordSchema, {
      repositoryName: this.name,
      tenantId,
      id,
      version: expectedVersion,
    });
    if (result.affected === 0 && (await this.findById(tenantId, id)) !== undefined) {
      throw new PersistenceConcurrencyError(`Entity ${id} version changed`);
    }
    return result.affected === 1;
  }
}
