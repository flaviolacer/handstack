import { EntitySchema } from 'typeorm';

export interface PortableImportState {
  exportId: string;
  sequence: number;
  status: string;
  manifest: string | null;
}

export interface PortableStagedRecord {
  exportId: string;
  sequence: number;
  repositoryName: string;
  tenantId: string;
  id: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  payload: string;
}

export const portableImportStateSchema = new EntitySchema<PortableImportState>({
  name: 'HandStackPortableImport',
  tableName: 'handstack_portable_imports',
  columns: {
    exportId: { name: 'export_id', type: String, primary: true, length: 120 },
    sequence: { type: Number },
    status: { type: String, length: 20 },
    manifest: { type: 'text', nullable: true },
  },
});

export const portableStagedRecordSchema = new EntitySchema<PortableStagedRecord>({
  name: 'HandStackPortableRecord',
  tableName: 'handstack_portable_records',
  columns: {
    exportId: { name: 'export_id', type: String, primary: true, length: 120 },
    sequence: { type: Number, primary: true },
    repositoryName: { name: 'repository_name', type: String, length: 120 },
    tenantId: { name: 'tenant_id', type: String, length: 64 },
    id: { type: String, length: 36 },
    version: { type: Number },
    createdAt: { name: 'created_at', type: Date },
    updatedAt: { name: 'updated_at', type: Date },
    payload: { type: 'text' },
  },
});
