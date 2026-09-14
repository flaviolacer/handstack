import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter, databaseDoctor, databaseMigrationStatus } from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('database operations', () => {
  it('reports applied migrations and validates the compact SQLite database', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    await adapter.initialize();
    try {
      const migrations = await databaseMigrationStatus(adapter);
      expect(migrations.adapter).toBe('sqljs');
      expect(migrations.applied).toEqual([
        'InitialSchema1735689600000',
        'PortableImport1735689600001',
      ]);
      expect(migrations.pending).toEqual([]);

      const report = await databaseDoctor(adapter);
      expect(report.healthy).toBe(true);
      expect(report.checks).toHaveLength(6);
      expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
    } finally {
      await adapter.close();
    }
  });
});
