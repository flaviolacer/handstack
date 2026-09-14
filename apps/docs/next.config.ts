import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const config: NextConfig = {
  transpilePackages: ['@handstack/docs-engine'],
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
  ...(process.platform === 'win32' ? {} : { output: 'standalone' }),
};

export default config;
