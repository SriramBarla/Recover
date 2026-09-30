import path from 'node:path';
import type { NextConfig } from 'next';

const root = path.resolve(process.cwd(), '../..');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // A trailing-slash redirect would be an unauthenticated non-401 response (F-123); proxy.ts answers instead.
  skipTrailingSlashRedirect: true,
  transpilePackages: ['@recover/shared'],
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default config;
