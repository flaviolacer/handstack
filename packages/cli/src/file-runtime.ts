import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { DatabaseCommandRuntime } from './database-command.js';
import { requiredPortableSigningKey } from './runtime-config.js';

export function createFileRuntime(environment: NodeJS.ProcessEnv): DatabaseCommandRuntime {
  return {
    signingKey() {
      return requiredPortableSigningKey(environment);
    },
    async *read(path) {
      const input = createReadStream(path, { encoding: 'utf8' });
      yield* createInterface({ input, crlfDelay: Infinity });
    },
    async write(path, content) {
      const output = createWriteStream(path, { encoding: 'utf8', flags: 'wx' });
      try {
        for await (const chunk of content) {
          if (!output.write(chunk)) await once(output, 'drain');
        }
        output.end();
        await once(output, 'finish');
      } catch (error) {
        output.destroy();
        throw error;
      }
    },
    output(value) {
      process.stdout.write(`${value}\n`);
    },
  };
}
