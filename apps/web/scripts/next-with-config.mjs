import { spawn } from 'node:child_process';
import { configLayerFromEnvironment } from '@handstack/config';

const [mode = 'dev', ...extraArgs] = process.argv.slice(2);
if (mode !== 'dev' && mode !== 'start') {
  throw new Error(`Unsupported Next mode: ${mode}`);
}

const port = configLayerFromEnvironment(process.env).server?.webPort ?? 3000;
const command = process.platform === 'win32' ? 'next.cmd' : 'next';
const child = spawn(command, [mode, ...extraArgs, '--port', String(port)], {
  env: { ...process.env, PORT: String(port) },
  stdio: 'inherit',
  shell: process.platform === 'win32',
  windowsHide: true,
});

child.once('error', (error) => {
  throw error;
});
child.once('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
