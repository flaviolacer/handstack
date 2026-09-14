import { EntitySchema } from 'typeorm';

export interface EntityRecord {
  repositoryName: string;
  tenantId: string;
  id: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  payload: string;
}

export const entityRecordSchema = new EntitySchema<EntityRecord>({
  name: 'HandStackEntityRecord',
  tableName: 'handstack_entities',
  columns: {
    repositoryName: { name: 'repository_name', type: String, primary: true, length: 120 },
    tenantId: { name: 'tenant_id', type: String, primary: true, length: 64 },
    id: { type: String, primary: true, length: 36 },
    version: { type: Number },
    createdAt: { name: 'created_at', type: Date },
    updatedAt: { name: 'updated_at', type: Date },
    payload: { type: 'text' },
  },
  indices: [
    {
      name: 'idx_handstack_entities_tenant_order',
      columns: ['repositoryName', 'tenantId', 'createdAt', 'id'],
    },
  ],
});
