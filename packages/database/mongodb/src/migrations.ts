import type { Db } from 'mongodb';
import {
  entityCollectionName,
  entityIndexes,
  entityValidator,
  migrationCollectionName,
  portableImportCollectionName,
  portableRecordCollectionName,
} from './schema.js';

export interface DocumentMigration {
  readonly version: number;
  readonly name: string;
  up(database: Db): Promise<void>;
}

export const documentMigrations: readonly DocumentMigration[] = [
  {
    version: 1,
    name: 'initial-entity-schema',
    async up(database) {
      const collections = await database.listCollections({ name: entityCollectionName }).toArray();
      if (collections.length === 0) {
        await database.createCollection(entityCollectionName, { validator: entityValidator });
      } else {
        await database.command({ collMod: entityCollectionName, validator: entityValidator });
      }
      await database.collection(entityCollectionName).createIndexes([...entityIndexes]);
    },
  },
  {
    version: 2,
    name: 'portable-import-staging',
    async up(database) {
      const names = new Set(
        (await database.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name),
      );
      if (!names.has(portableImportCollectionName)) {
        await database.createCollection(portableImportCollectionName);
      }
      if (!names.has(portableRecordCollectionName)) {
        await database.createCollection(portableRecordCollectionName);
      }
      await database
        .collection(portableImportCollectionName)
        .createIndex({ exportId: 1 }, { unique: true, name: 'uq_portable_import_export' });
      await database
        .collection(portableRecordCollectionName)
        .createIndex(
          { exportId: 1, sequence: 1 },
          { unique: true, name: 'uq_portable_record_sequence' },
        );
    },
  },
];

export async function runDocumentMigrations(database: Db): Promise<void> {
  const state = database.collection<{ version: number; name: string; appliedAt: Date }>(
    migrationCollectionName,
  );
  await state.createIndex({ version: 1 }, { unique: true, name: 'uq_handstack_migration_version' });
  const applied = new Set(
    (await state.find({}, { projection: { version: 1 } }).toArray()).map((item) => item.version),
  );
  for (const migration of [...documentMigrations].sort(
    (left, right) => left.version - right.version,
  )) {
    if (applied.has(migration.version)) continue;
    await migration.up(database);
    await state.insertOne({
      version: migration.version,
      name: migration.name,
      appliedAt: new Date(),
    });
  }
}
