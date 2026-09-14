import type { IndexDescription, Document } from 'mongodb';

export const entityCollectionName = 'handstack_entities';
export const migrationCollectionName = 'handstack_migrations';
export const portableImportCollectionName = 'handstack_portable_imports';
export const portableRecordCollectionName = 'handstack_portable_records';

export const entityValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['repositoryName', 'tenantId', 'id', 'version', 'createdAt', 'updatedAt', 'payload'],
    additionalProperties: false,
    properties: {
      _id: {},
      repositoryName: { bsonType: 'string', minLength: 1, maxLength: 120 },
      tenantId: { bsonType: 'string', minLength: 1, maxLength: 64 },
      id: { bsonType: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
      version: { bsonType: 'int', minimum: 1 },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
      payload: { bsonType: 'object' },
    },
  },
};

export const entityIndexes: readonly IndexDescription[] = [
  {
    name: 'uq_handstack_entities_tenant_id',
    key: { repositoryName: 1, tenantId: 1, id: 1 },
    unique: true,
  },
  {
    name: 'idx_handstack_entities_tenant_order',
    key: { repositoryName: 1, tenantId: 1, id: 1 },
  },
];
