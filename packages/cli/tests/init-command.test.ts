import { describe, expect, it } from 'vitest';
import { executeInitCommand } from '../src/init-command.js';

describe('init command', () => {
  it('writes an explicit SQLite configuration without overwriting existing files', async () => {
    const writes: string[] = [];
    const output: string[] = [];
    await executeInitCommand(['init'], {
      write: async (path, content) => {
        const chunks: string[] = [];
        for await (const chunk of content) chunks.push(chunk);
        writes.push(`${path}:${chunks.join('')}`);
        await Promise.resolve();
      },
      output: (value) => output.push(value),
    });
    expect(writes[0]).toContain('handstack.config.ts:');
    expect(writes[0]).toContain("adapter: 'sqlite'");
    expect(output).toEqual(['Created handstack.config.ts']);
  });

  it('reports an existing configuration file', async () => {
    await expect(
      executeInitCommand(['init'], {
        write: () => Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' })),
        output: () => undefined,
      }),
    ).rejects.toThrow('already exists');
  });
});
