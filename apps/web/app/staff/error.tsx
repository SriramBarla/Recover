'use client';

import { Button, buttonClass } from '@/components/ui/button.tsx';
import { IconBuilding, IconRefresh } from '@/components/ui/icons.tsx';
import { Notice } from '@/components/ui/notice.tsx';

// Error boundary for the staff app. Server error details never reach the browser; the digest lets
// an operator find the matching server log line.
export default function StaffError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="container-narrow stack-lg" style={{ paddingTop: '3rem' }}>
      <h1>Something went wrong</h1>
      <Notice tone="danger" live="assertive">
        Recover could not load this page. The database or a service it depends on may be unavailable.
      </Notice>
      <div className="button-row">
        <Button variant="primary" onClick={() => reset()} icon={<IconRefresh />}>
          Try again
        </Button>
        <a className={buttonClass({})} href="/staff">
          <IconBuilding />
          Choose a school
        </a>
      </div>
      {error.digest ? <p className="small muted mono">Reference: {error.digest}</p> : null}
    </main>
  );
}
