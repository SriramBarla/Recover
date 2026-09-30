// Startup checks. Next.js calls register() once per server instance, in every runtime, before it serves
// requests. The checks are imported on Node.js only: the shared logger writes to process.stderr, which
// an Edge bundle cannot contain (Next.js instrumentation guide, "Importing runtime-specific code").
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { reportDeviceKeys, reportIgnoredDevFlags } = await import('./lib/startup.ts');
    reportIgnoredDevFlags();
    reportDeviceKeys();
  }
}
