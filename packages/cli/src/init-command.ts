export interface InitCommandRuntime {
  readonly write: (path: string, content: AsyncIterable<string>) => Promise<void>;
  readonly output: (value: string) => void;
}

const DEFAULT_CONFIG = `import { defineConfig } from '@handstack/config';

export default defineConfig({
  database: {
    adapter: 'sqlite',
    url: 'file:./handstack.db',
  },
});
`;

async function* text(value: string): AsyncIterable<string> {
  await Promise.resolve();
  yield value;
}

export async function executeInitCommand(
  args: readonly string[],
  runtime: InitCommandRuntime,
): Promise<void> {
  if (args.length > 0 && args[0] !== 'init') throw new Error('Usage: handstack init');
  const path = args[1] ?? 'handstack.config.ts';
  try {
    await runtime.write(path, text(DEFAULT_CONFIG));
  } catch (error) {
    if ((error as { code?: unknown }).code === 'EEXIST')
      throw new Error(`Configuration file already exists: ${path}`);
    throw error;
  }
  runtime.output(`Created ${path}`);
}
