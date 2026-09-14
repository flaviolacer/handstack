import { describe, expect, it } from 'vitest';
import { documentMigrations, entityIndexes, entityValidator } from '../src/index.js';

describe('MongoDB managed schema', () => {
  it('requires tenant, canonical ID, version, timestamps and payload', () => {
    const schema = entityValidator.$jsonSchema as { required: string[] };
    expect(schema.required).toEqual(
      expect.arrayContaining(['tenantId', 'id', 'version', 'createdAt', 'updatedAt', 'payload']),
    );
  });
  it('declares tenant-scoped unique and ordering indexes', () => {
    expect(entityIndexes).toHaveLength(2);
    expect(entityIndexes[0]).toMatchObject({
      unique: true,
      key: { repositoryName: 1, tenantId: 1, id: 1 },
    });
  });
  it('keeps document migrations unique and ordered', () => {
    const versions = documentMigrations.map((migration) => migration.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });
});
