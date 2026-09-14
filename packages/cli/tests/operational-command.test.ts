import { defineConfig } from '@handstack/config';
import { createDatabaseAdapter } from '@handstack/database';
import { executeDoctorCommand, executeMigrateCommand } from '../src/index.js';
import { describe, expect, it } from 'vitest';

describe('operational CLI commands', () => {
  it('emits machine-readable migration and doctor reports', async () => {
    const adapter = createDatabaseAdapter(
      defineConfig({ database: { adapter: 'sqlite', url: 'file::memory:' } }),
    );
    const output: string[] = [];
    await adapter.initialize();
    try {
      await executeMigrateCommand(adapter, { output: (value) => output.push(value) });
      await executeDoctorCommand(adapter, { output: (value) => output.push(value) });
    } finally {
      await adapter.close();
    }

    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      command: 'migrate',
      adapter: 'sqljs',
      pending: [],
    });
    expect(JSON.parse(output[1] ?? '{}')).toMatchObject({
      command: 'doctor',
      adapter: 'sqljs',
      healthy: true,
    });
  });
});
