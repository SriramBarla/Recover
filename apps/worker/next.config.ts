import path from 'node:path';
import type { NextConfig } from 'next';

const root = path.resolve(process.cwd(), '../..');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@recover/shared'],
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default config;
