import { executeApplyCommand, type ApplyCommandRuntime } from './apply-command.js';

export interface ConfigSyncRuntime {
  readonly verifyRef: (repository: string, ref: string) => Promise<void>;
  readonly readAtRef: (repository: string, ref: string, path: string) => Promise<string>;
  readonly request: NonNullable<ApplyCommandRuntime['request']>;
  readonly output: (value: string) => void;
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith('-')) throw new Error(`${name} is required`);
  return value;
}

/** Applies a manifest from an already checked-out Git ref through the canonical apply path. */
export async function executeConfigSyncCommand(
  args: readonly string[],
  runtime: ConfigSyncRuntime,
): Promise<void> {
  if (args[0] !== 'config' || args[1] !== 'sync')
    throw new Error('Usage: handstack config sync --repo <path> --ref <ref> -f <manifest>');
  const repository = option(args, '--repo');
  const ref = option(args, '--ref');
  const manifestPath = option(args, '-f');
  await runtime.verifyRef(repository, ref);
  const content = await runtime.readAtRef(repository, ref, manifestPath);
  await executeApplyCommand(['apply', '-f', manifestPath], {
    read: () => Promise.resolve(content),
    request: runtime.request,
    output: runtime.output,
  });
  runtime.output(`Configuration synchronized from ${repository}@${ref}:${manifestPath}`);
}
