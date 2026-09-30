import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { register } from 'tsx/cjs/api';
import type { HandStackConfigLayer } from '@handstack/config';

interface ConfigModule {
  default?: HandStackConfigLayer | ((...args: never[]) => HandStackConfigLayer);
}

/** Loads the checked-in TypeScript config layer used by the CLI hierarchy. */
export function loadConfigFile(cwd = process.cwd()): HandStackConfigLayer {
  const path = resolve(cwd, 'handstack.config.ts');
  if (!existsSync(path)) return {};
  const unregister = register();
  try {
    const loaded = createRequire(import.meta.url)(path) as ConfigModule;
    const candidate: unknown = loaded.default;
    const value =
      typeof candidate === 'function' ? (candidate as () => HandStackConfigLayer)() : candidate;
    if (value === undefined || typeof value !== 'object' || value === null || Array.isArray(value))
      throw new TypeError(
        'handstack.config.ts must export a config object or defineConfig function',
      );
    return value;
  } finally {
    unregister();
  }
}
