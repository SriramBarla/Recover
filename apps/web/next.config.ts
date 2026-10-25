import path from 'node:path';
import type { NextConfig } from 'next';

const root = path.resolve(process.cwd(), '../..');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev-tools badge renders unstyled under the nonce CSP (a grey box in the corner); dev only.
  devIndicators: false,
  transpilePackages: ['@recover/shared'],
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default config;
