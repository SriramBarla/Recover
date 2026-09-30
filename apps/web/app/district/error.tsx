'use client';

// Error boundary for the district pages; server error details never reach the browser.
export default function DistrictError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="stack-lg">
      <h1>Something went wrong</h1>
      <div className="notice notice-danger" role="alert">
        Recover could not load this page. The database or a service it depends on may be unavailable.
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={() => reset()}>
          Try again
        </button>
        <a className="btn" href="/district">
          District overview
        </a>
      </div>
      {error.digest ? <p className="small muted mono">Reference: {error.digest}</p> : null}
    </div>
  );
}
