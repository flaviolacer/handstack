import {
  entityCollectionName,
  MongoAdapter,
  portableImportCollectionName,
  portableRecordCollectionName,
} from '@handstack/database-mongodb';
import {
  entityRecordSchema,
  portableImportStateSchema,
  portableStagedRecordSchema,
  type EntityRecord,
  TypeOrmAdapter,
} from '@handstack/database-typeorm';
import type {
  PortableImportSession,
  PortableManifest,
  PortableObject,
  PortableRecord,
  PortableSink,
  PortableSource,
} from './portable.js';

function portableValue(payload: unknown, createdAt: Date, updatedAt: Date): PortableObject {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Stored entity payload must be an object');
  }
  return {
    ...(payload as PortableObject),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

function sqlSource(adapter: TypeOrmAdapter): PortableSource {
  return {
    async *records(scope) {
      const pageSize = 200;
      let offset = 0;
      const repository = adapter.dataSource.getRepository(entityRecordSchema);
      for (;;) {
        const findOptions = {
          ...(scope.tenantId === undefined ? {} : { where: { tenantId: scope.tenantId } }),
          order: { repositoryName: 'ASC', tenantId: 'ASC', id: 'ASC' } as const,
          skip: offset,
          take: pageSize,
        };
        const rows: EntityRecord[] = await repository.find(findOptions);
        for (const record of rows) {
          yield {
            repository: record.repositoryName,
            tenantId: record.tenantId,
            id: record.id,
            version: record.version,
            value: portableValue(
              JSON.parse(record.payload) as unknown,
              record.createdAt,
              record.updatedAt,
            ),
          } satisfies PortableRecord;
        }
        if (rows.length < pageSize) break;
        offset += rows.length;
      }
    },
    metadata() {
      return Promise.resolve({
        logicalIndexes: [
          { repository: '*', fields: ['repository', 'tenantId', 'id'], unique: true },
          { repository: '*', fields: ['repository', 'tenantId', 'createdAt', 'id'] },
        ],
        versions: { persistence: '1', adapter: adapter.dataSource.options.type },
      });
    },
  };
}

function mongoSource(adapter: MongoAdapter): PortableSource {
  return {
    async *records(scope) {
      const filter = scope.tenantId === undefined ? {} : { tenantId: scope.tenantId };
      const cursor = adapter
        .nativeDatabase()
        .collection<{
          repositoryName: string;
          tenantId: string;
          id: string;
          version: number;
          createdAt: Date;
          updatedAt: Date;
          payload: PortableObject;
        }>('handstack_entities')
        .find(filter)
        .sort({ repositoryName: 1, tenantId: 1, id: 1 });
      for await (const document of cursor) {
        yield {
          repository: document.repositoryName,
          tenantId: document.tenantId,
          id: document.id,
          version: document.version,
          value: portableValue(document.payload, document.createdAt, document.updatedAt),
        } satisfies PortableRecord;
      }
    },
    metadata() {
      return Promise.resolve({
        logicalIndexes: [
          { repository: '*', fields: ['repository', 'tenantId', 'id'], unique: true },
          { repository: '*', fields: ['repository', 'tenantId', 'id'] },
        ],
        versions: { persistence: '1', adapter: 'mongodb' },
      });
    },
  };
}

export function createPortableSource(adapter: unknown): PortableSource {
  if (adapter instanceof MongoAdapter) return mongoSource(adapter);
  if (adapter instanceof TypeOrmAdapter) return sqlSource(adapter);
  throw new TypeError('Unsupported database adapter for portable export');
}

function importParts(record: PortableRecord): {
  createdAt: Date;
  updatedAt: Date;
  payload: PortableObject;
} {
  const { createdAt, updatedAt, ...payload } = record.value;
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') {
    throw new Error('Portable record timestamps are required');
  }
  const created = new Date(createdAt);
  const updated = new Date(updatedAt);
  if (Number.isNaN(created.valueOf()) || Number.isNaN(updated.valueOf())) {
    throw new Error('Portable record timestamps are invalid');
  }
  return { createdAt: created, updatedAt: updated, payload };
}

function sqlSink(adapter: TypeOrmAdapter): PortableSink {
  const states = adapter.dataSource.getRepository(portableImportStateSchema);
  const staged = adapter.dataSource.getRepository(portableStagedRecordSchema);
  return {
    async resumeSequence(exportId) {
      return (await states.findOneBy({ exportId }))?.sequence ?? 0;
    },
    async begin(exportId) {
      if ((await states.findOneBy({ exportId })) === null) {
        await states.insert({ exportId, sequence: 0, status: 'staging', manifest: null });
      }
      const session: PortableImportSession = {
        async stage(record, sequence) {
          const parts = importParts(record);
          await staged.insert({
            exportId,
            sequence,
            repositoryName: record.repository,
            tenantId: record.tenantId,
            id: record.id,
            version: record.version,
            createdAt: parts.createdAt,
            updatedAt: parts.updatedAt,
            payload: JSON.stringify(parts.payload),
          });
        },
        async checkpoint(sequence) {
          await states.update({ exportId }, { sequence });
        },
        async commit(manifest: PortableManifest) {
          await adapter.dataSource.transaction(async (manager) => {
            const records = await manager.find(portableStagedRecordSchema, {
              where: { exportId },
              order: { sequence: 'ASC' },
            });
            for (const record of records) {
              await manager.insert(entityRecordSchema, {
                repositoryName: record.repositoryName,
                tenantId: record.tenantId,
                id: record.id,
                version: record.version,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
                payload: record.payload,
              });
            }
            await manager.delete(portableStagedRecordSchema, { exportId });
            await manager.update(
              portableImportStateSchema,
              { exportId },
              { status: 'completed', manifest: JSON.stringify(manifest) },
            );
          });
        },
        async rollback() {
          await staged.delete({ exportId });
          await states.delete({ exportId });
        },
      };
      return session;
    },
  };
}

interface MongoImportState {
  exportId: string;
  sequence: number;
  status: string;
  manifest?: PortableManifest;
}

interface MongoStagedRecord extends PortableRecord {
  exportId: string;
  sequence: number;
}

function mongoSink(adapter: MongoAdapter): PortableSink {
  const database = adapter.nativeDatabase();
  const states = database.collection<MongoImportState>(portableImportCollectionName);
  const staged = database.collection<MongoStagedRecord>(portableRecordCollectionName);
  return {
    async resumeSequence(exportId) {
      return (await states.findOne({ exportId }))?.sequence ?? 0;
    },
    async begin(exportId) {
      await states.updateOne(
        { exportId },
        { $setOnInsert: { exportId, sequence: 0, status: 'staging' } },
        { upsert: true },
      );
      return {
        async stage(record, sequence) {
          importParts(record);
          await staged.insertOne({ ...record, exportId, sequence });
        },
        async checkpoint(sequence) {
          await states.updateOne({ exportId }, { $set: { sequence } });
        },
        async commit(manifest) {
          const session = adapter.nativeClient().startSession();
          try {
            await session.withTransaction(async () => {
              const records = await staged
                .find({ exportId }, { session })
                .sort({ sequence: 1 })
                .toArray();
              if (records.length > 0) {
                await database.collection(entityCollectionName).insertMany(
                  records.map((record) => {
                    const parts = importParts(record);
                    return {
                      repositoryName: record.repository,
                      tenantId: record.tenantId,
                      id: record.id,
                      version: record.version,
                      createdAt: parts.createdAt,
                      updatedAt: parts.updatedAt,
                      payload: parts.payload,
                    };
                  }),
                  { session },
                );
              }
              await staged.deleteMany({ exportId }, { session });
              await states.updateOne(
                { exportId },
                { $set: { status: 'completed', manifest } },
                { session },
              );
            });
          } finally {
            await session.endSession();
          }
        },
        async rollback() {
          await staged.deleteMany({ exportId });
          await states.deleteOne({ exportId });
        },
      } satisfies PortableImportSession;
    },
  };
}

export function createPortableSink(adapter: unknown): PortableSink {
  if (adapter instanceof MongoAdapter) return mongoSink(adapter);
  if (adapter instanceof TypeOrmAdapter) return sqlSink(adapter);
  throw new TypeError('Unsupported database adapter for portable import');
}
