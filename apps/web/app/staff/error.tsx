'use client';

// Error boundary for the staff app. Server error details never reach the browser; the digest lets
// an operator find the matching server log line.
export default function StaffError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="container-narrow stack-lg" style={{ paddingTop: '3rem' }}>
      <h1>Something went wrong</h1>
      <div className="notice notice-danger" role="alert">
        Recover could not load this page. The database or a service it depends on may be unavailable.
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={() => reset()}>
          Try again
        </button>
        <a className="btn" href="/staff">
          Choose a school
        </a>
      </div>
      {error.digest ? <p className="small muted mono">Reference: {error.digest}</p> : null}
    </main>
  );
}
