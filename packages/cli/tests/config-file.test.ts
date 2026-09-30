import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFile } from '../src/config-file.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('CLI configuration file loader', () => {
  it('loads the TypeScript config layer used in the precedence hierarchy', () => {
    expect(loadConfigFile(fixtures)).toEqual({
      database: { adapter: 'sqlite', url: 'file:./fixture.db' },
      telemetry: { enabled: true },
    });
  });

  it('returns an empty layer when the working directory has no config file', () => {
    expect(loadConfigFile(resolve(fixtures, 'missing'))).toEqual({});
  });
});
