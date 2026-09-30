import { pathToFileURL } from 'node:url';

const artifact = process.argv[2];
const operation = process.argv[3] ?? 'setup';
if (artifact === undefined || artifact.trim() === '')
  throw new Error('Plugin artifact path is required');
const loaded = (await import(pathToFileURL(artifact).href)) as {
  readonly default?: {
    readonly manifest?: { readonly name?: string; readonly handstack?: { readonly mode?: string } };
    readonly setup?: (context: unknown) => void | Promise<void>;
    readonly onInstall?: () => void | Promise<void>;
    readonly onEnable?: () => void | Promise<void>;
    readonly onDisable?: () => void | Promise<void>;
    readonly onUninstall?: () => void | Promise<void>;
  };
};
if (loaded.default?.manifest?.name === undefined || typeof loaded.default.setup !== 'function')
  throw new Error('Plugin definition is invalid');
const emit = (type: string, value: unknown): void => {
  process.stdout.write(`${JSON.stringify({ type, value })}\n`);
};
const pendingRpc = new Map<
  string,
  { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
>();
let rpcSequence = 0;
let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  stdinBuffer += chunk;
  let newline = stdinBuffer.indexOf('\n');
  while (newline >= 0) {
    const line = stdinBuffer.slice(0, newline).trim();
    stdinBuffer = stdinBuffer.slice(newline + 1);
    if (line !== '') {
      const message = JSON.parse(line) as {
        readonly type?: unknown;
        readonly id?: unknown;
        readonly result?: unknown;
        readonly error?: unknown;
      };
      if (message.type === 'handstack_rpc_response' && typeof message.id === 'string') {
        const pending = pendingRpc.get(message.id);
        if (pending !== undefined) {
          pendingRpc.delete(message.id);
          if (typeof message.error === 'string') pending.reject(new Error(message.error));
          else pending.resolve(message.result);
        }
      }
    }
    newline = stdinBuffer.indexOf('\n');
  }
});
const requestHost = (method: string, params: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = String(++rpcSequence);
    pendingRpc.set(id, { resolve, reject });
    process.stdout.write(
      `${JSON.stringify({
        type: 'handstack_rpc_request',
        id,
        request: { method, params },
      })}\n`,
    );
  });
const context = {
  pluginName: loaded.default.manifest.name,
  mode: 'isolated' as const,
  secrets: {
    get: (reference: string): Promise<string | undefined> =>
      requestHost('secrets.get', { reference }).then((value) =>
        typeof value === 'string' ? value : undefined,
      ),
  },
  tools: {
    register: (value: unknown) => {
      emit('tool', value);
    },
  },
  providers: {
    register: (value: unknown) => {
      emit('provider', value);
    },
  },
  capabilities: {
    register: (value: unknown) => {
      emit('capability', value);
      return Promise.resolve(undefined);
    },
  },
  ui: {
    register: (value: unknown) => {
      emit('ui', value);
    },
  },
  identity: {
    register: (value: unknown) => {
      emit('identity', value);
    },
  },
};
emit('ready', undefined);
try {
  if (operation === 'setup') await loaded.default.setup(context);
  else if (operation === 'onInstall') await loaded.default.onInstall?.();
  else if (operation === 'onEnable') await loaded.default.onEnable?.();
  else if (operation === 'onDisable') await loaded.default.onDisable?.();
  else if (operation === 'onUninstall') await loaded.default.onUninstall?.();
  else throw new Error(`Unsupported plugin lifecycle operation: ${operation}`);
} finally {
  process.stdin.destroy();
}
