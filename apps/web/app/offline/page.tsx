// Static "unavailable" page (§16.2 degraded modes). The service worker precaches it and serves it when a
// student page cannot be loaded. It needs no JavaScript, no data and no stylesheet: offline, only this
// HTML is available, so the few styles it needs are inline attributes.
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Recover is unavailable' };

export default function OfflinePage() {
  return (
    <main
      id="main"
      style={{ maxWidth: '36rem', margin: '0 auto', padding: '3rem 1rem', font: '16px/1.5 system-ui, -apple-system, sans-serif' }}
    >
      <p style={{ fontWeight: 700, margin: '0 0 1rem' }}>Recover</p>
      <h1 style={{ fontSize: '1.6rem', lineHeight: 1.2, margin: '0 0 1rem' }}>Recover is unavailable right now</h1>
      <p>If you found something, take it to the front office.</p>
      <p>If you lost something, ask at the front office. They can help even when Recover is down.</p>
      <form>
        <button type="submit" style={{ minHeight: '44px', padding: '0.6rem 1rem', font: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
          Try again
        </button>
      </form>
    </main>
  );
}
