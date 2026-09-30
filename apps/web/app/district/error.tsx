'use client';

import { Button, buttonClass } from '@/components/ui/button.tsx';
import { IconHome, IconRefresh } from '@/components/ui/icons.tsx';
import { Notice } from '@/components/ui/notice.tsx';

// Error boundary for the district pages; server error details never reach the browser.
export default function DistrictError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="stack-lg">
      <h1>Something went wrong</h1>
      <Notice tone="danger" live="assertive">
        Recover could not load this page. The database or a service it depends on may be unavailable.
      </Notice>
      <div className="button-row">
        <Button variant="primary" onClick={() => reset()} icon={<IconRefresh />}>
          Try again
        </Button>
        <a className={buttonClass({})} href="/district">
          <IconHome />
          District overview
        </a>
      </div>
      {error.digest ? <p className="small muted mono">Reference: {error.digest}</p> : null}
    </div>
  );
}
